'use strict';
/*
 * Moss service worker: keeps chrome.userScripts in sync with storage, runs the
 * background runner for extension-mode scripts, hosts the privileged API, migrates
 * stored data, and checks imported scripts for updates.
 *
 * struct state {                     cached view of storage, rebuilt after changes
 *     scripts: { [id]: struct script };
 *     modules: { [name]: struct module };
 *     settings: resolved settings;
 *     tokens: { [id]: secret };
 *     metas: { [id]: struct meta };
 * }
 */
import './shared/host/core.js';
import './shared/host/values.js';
import './shared/host/xhr.js';
import './shared/host/notify.js';
import './shared/host/menu.js';
import './shared/host/tabs.js';
import './shared/host/download.js';
import './shared/host/chrome.js';
import { build, plan } from './lib/bundler.js';
import { parse_meta } from './lib/meta.js';
import { migrate_state, upgrade_examples, SCHEMA_VERSION } from './lib/migrate.js';
import { missing_permissions } from './lib/permissions.js';
import { host_policy, resolve_settings } from './lib/settings.js';
import { load_text, sources_create } from './lib/sources.js';
import { load_modules, load_scripts, load_settings_raw, load_updates, new_id, put_script, record_update, tokens_for } from './lib/store.js';
import { apply_update, check_for_update } from './lib/updater.js';

const RUNNER = 'src/runner/offscreen.html';
const EXAMPLES = ['page-tools.user.js', 'fetch-logger.user.js'];
const EXAMPLE_MODULES = { 'utils/text': 'src/examples/utils-text.js' };
const UPDATE_ALARM = 'moss-updates';

let state = null;          // Promise<struct state> | null
let booting = null;        // Promise | null

// ---------- boot: seed or migrate, once per worker start ----------

/*
 * boot() — bring storage up to date before anything reads it. Runs on every worker
 * start, whatever onInstalled says (Chrome may report an install for an extension that
 * already has data): empty storage gets the examples, older storage is migrated.
 */
function boot() {
    if (booting !== null) {
        return booting;
    }
    booting = (async function () {
        const data = await chrome.storage.local.get(['schema_version', 'scripts', 'modules', 'settings', 'updates', 'requireCache']);
        const fresh = data.scripts === undefined && data.modules === undefined && data.settings === undefined;
        if (fresh) {
            await seed_examples();
            return;
        }
        const result = migrate_state(data);
        if (!result.changed) {
            return;
        }
        const next = result.data;
        await upgrade_examples(next.scripts, next.modules, load_text);
        await chrome.storage.local.set({
            schema_version: SCHEMA_VERSION,
            scripts: next.scripts,
            modules: next.modules,
            settings: next.settings,
            updates: next.updates,
        });
        if (next.require_cache !== undefined) {
            await chrome.storage.local.set({ require_cache: next.require_cache });
            await chrome.storage.local.remove('requireCache');
        }
    })();
    return booting;
}

// ---------- state ----------

/*
 * get_state() -> Promise<struct state>
 */
function get_state() {
    if (state === null) {
        state = (async function () {
            await boot();
            const scripts = await load_scripts();
            const modules = await load_modules();
            const settings = resolve_settings(await load_settings_raw());
            host.policy = host_policy(settings);
            const tokens = await tokens_for(Object.keys(scripts));
            const metas = {};
            for (const id of Object.keys(scripts)) {
                metas[id] = parse_meta(scripts[id].code).meta;
            }
            return { scripts: scripts, modules: modules, settings: settings, tokens: tokens, metas: metas };
        })();
    }
    return state;
}

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !(changes.scripts || changes.modules || changes.settings)) {
        return;
    }
    state = null;
    schedule_sync();
});

// ---------- privileged API host ----------

/*
 * get_script(conn) -> struct script_info for an enabled script whose token checks out, or null
 */
async function get_script(conn) {
    const st = await get_state();
    const s = st.scripts[conn.script_id];
    if (s === undefined || !s.enabled) {
        return null;
    }
    if (!conn.trusted && st.tokens[s.id] !== conn.token) {
        return null;
    }
    const meta = st.metas[s.id];
    return { id: s.id, name: meta.name, grants: meta.grant, connect: meta.connect };
}

let error_writes = Promise.resolve();

/*
 * record_error(script, message) — keep the latest runtime errors per script for the
 * popup and dashboard, and put a red "!" on the toolbar icon
 */
function record_error(script, message) {
    error_writes = error_writes.then(async function () {
        const got = await chrome.storage.session.get('script_errors');
        const errors = got.script_errors || {};
        const list = [{ at: Date.now(), message: message }].concat(errors[script.id] || []);
        errors[script.id] = list.slice(0, 5);
        await chrome.storage.session.set({ script_errors: errors });
        await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
        await chrome.action.setBadgeText({ text: '!' });
    }).catch(function () {});
}

const host = moss_host({
    icon: chrome.runtime.getURL('icons/icon128.png'),
    on_error: record_error,
    get_script: get_script,
});

// Sandboxed scripts connect from the USER_SCRIPT world…
if (chrome.runtime.onUserScriptConnect) {
    chrome.runtime.onUserScriptConnect.addListener(function (port) {
        const parts = port.name.split(':');
        if (parts[0] !== 'moss') {
            port.disconnect();
            return;
        }
        const sender = port.sender || {};
        host.attach_port(port, {
            script_id: parts[1],
            token: parts[2],
            tab_id: sender.tab ? sender.tab.id : null,
            url: sender.url,
        });
    });
}
// …and background scripts through the offscreen runner.
chrome.runtime.onConnect.addListener(function (port) {
    if (!port.sender || port.sender.url !== chrome.runtime.getURL(RUNNER) || !port.name.startsWith('moss-bg:')) {
        return;
    }
    host.attach_port(port, { script_id: port.name.slice('moss-bg:'.length), trusted: true, tab_id: null });
});

// ---------- building & registering ----------

/*
 * user_scripts_available() -> true when "Allow User Scripts" is on
 */
async function user_scripts_available() {
    try {
        await chrome.userScripts.getScripts();
        return true;
    } catch (e) {
        return false;
    }
}

/*
 * registration(s, p, code) -> the chrome.userScripts registration of a page script
 */
function registration(s, p, code) {
    const t = p.targets;
    const reg = {
        id: s.id,
        js: [{ code: code }],
        matches: t.matches,
        runAt: t.run_at,
        allFrames: t.all_frames,
        world: (p.mode === 'page' || p.inject === 'raw') ? 'MAIN' : 'USER_SCRIPT',
    };
    if (t.exclude_matches.length > 0) {
        reg.excludeMatches = t.exclude_matches;
    }
    if (t.include_globs.length > 0) {
        reg.includeGlobs = t.include_globs;
    }
    if (t.exclude_globs.length > 0) {
        reg.excludeGlobs = t.exclude_globs;
    }
    return reg;
}

/*
 * build_all() -> { page_scripts: registrations, background: [{ id, code }], errors: { id: message } }
 */
async function build_all() {
    const st = await get_state();
    const sources = sources_create(st.modules);
    const out = { page_scripts: [], background: [], errors: {} };
    for (const id of Object.keys(st.scripts)) {
        const s = st.scripts[id];
        if (!s.enabled) {
            continue;
        }
        try {
            const p = await plan(s, { sources: sources, settings: st.settings, target: 'moss' });
            if (p.errors.length > 0) {
                throw new Error(p.errors.join('\n'));
            }
            const code = await build(p, { sources: sources, script: s, token: st.tokens[s.id], settings: st.settings });
            if (p.mode === 'extension') {
                out.background.push({ id: s.id, code: code });
            } else {
                out.page_scripts.push(registration(s, p, code));
            }
        } catch (e) {
            out.errors[s.id] = e.message;
        }
    }
    return out;
}

/*
 * has_runner() -> true if the offscreen runner document exists
 */
async function has_runner() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
}

let creating_runner = null;

/*
 * sync_runner(scripts, keepalive) — start, update or close the background runner
 */
async function sync_runner(scripts, keepalive) {
    const exists = await has_runner();
    if (scripts.length === 0) {
        if (exists) {
            await chrome.offscreen.closeDocument();
        }
        return;
    }
    if (exists) {
        try {
            await chrome.runtime.sendMessage({ target: 'runner', type: 'load', value: { scripts: scripts, keepalive: keepalive } });
        } catch (e) {
            // runner still starting; it asks for its scripts itself
        }
        return;
    }
    // A fresh runner asks for its scripts itself ("runner.scripts").
    if (creating_runner === null) {
        creating_runner = chrome.offscreen.createDocument({
            url: RUNNER,
            reasons: ['IFRAME_SCRIPTING'],
            justification: 'Runs extension-mode user scripts inside sandboxed iframes.',
        }).finally(function () {
            creating_runner = null;
        });
    }
    await creating_runner;
}

/*
 * sync() — rebuild every script and register it with Chrome
 */
async function sync() {
    const st = await get_state();
    const built = await build_all();
    const available = await user_scripts_available();
    if (available) {
        await chrome.userScripts.configureWorld({ messaging: true });
        await chrome.userScripts.unregister();
        // One at a time, so one bad script can't block the others.
        for (const reg of built.page_scripts) {
            try {
                await chrome.userScripts.register([reg]);
            } catch (e) {
                built.errors[reg.id] = `Could not register: ${e.message}`;
            }
        }
    }
    await sync_runner(built.background, st.settings['runtime.keepalive']);
    // Scripts were rebuilt, so earlier runtime errors are stale.
    await chrome.storage.session.set({
        sync_status: { at: Date.now(), user_scripts: available, errors: built.errors },
        script_errors: {},
    });
    await chrome.action.setBadgeText({ text: '' });
}

let sync_timer = null;
let syncing = Promise.resolve();

/*
 * schedule_sync() — sync soon, once, however many changes arrive meanwhile
 */
function schedule_sync() {
    clearTimeout(sync_timer);
    sync_timer = setTimeout(function () {
        syncing = syncing.then(sync).catch(function (e) {
            console.error('Moss sync failed', e);
        });
    }, 150);
}

// ---------- updates from GitHub / URLs ----------

/*
 * ensure_update_alarm() — the periodic alarm that drives auto-updates
 */
async function ensure_update_alarm() {
    const alarm = await chrome.alarms.get(UPDATE_ALARM);
    if (!alarm) {
        await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
    }
}
ensure_update_alarm();
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === UPDATE_ALARM) {
        run_updates({ all: false });
    }
});

/*
 * update_one(s, st, summary, manual) — check one script, apply an update, record the outcome
 */
async function update_one(s, st, summary, manual) {
    const name = st.metas[s.id].name;
    try {
        const check = await check_for_update(s, { settings: st.settings, manual: manual });
        if (check.status !== 'update') {
            await record_update(s.id, { status: check.status, error: null });
            return;
        }
        await put_script(apply_update(s, check));
        const missing = await missing_permissions(check.code);
        let note = null;
        if (missing.length > 0) {
            note = `Updated, but it now needs the ${missing.join(', ')} permission — open it and click Save.`;
        }
        await record_update(s.id, { status: 'updated', version: check.version, updated_at: Date.now(), error: note });
        summary.updated.push(`${name} ${check.version}`);
    } catch (e) {
        await record_update(s.id, { status: 'error', error: e.message });
        summary.errors.push(`${name}: ${e.message}`);
    }
}

let updating = null;

/*
 * run_updates({ all }) -> { checked, updated: string[], errors: string[] }
 *   all false: only scripts with auto-update on whose interval has passed;
 *   all true: every script with a source ("Check all now").
 */
function run_updates(opts) {
    if (updating !== null) {
        return updating;
    }
    updating = (async function () {
        const st = await get_state();
        const updates = await load_updates();
        const summary = { checked: 0, updated: [], errors: [] };
        for (const id of Object.keys(st.scripts)) {
            const s = st.scripts[id];
            if (!s.source || !s.source.url) {
                continue;
            }
            const every = (s.source.every || st.settings['update.every']) * 60e3;
            const last = updates[id] ? updates[id].checked_at : 0;
            if (!opts.all && (!s.source.auto || Date.now() - last < every)) {
                continue;
            }
            summary.checked++;
            await update_one(s, st, summary, opts.all);
        }
        if (summary.updated.length > 0 && st.settings['update.notify']) {
            const count = summary.updated.length;
            chrome.notifications.create({
                type: 'basic',
                iconUrl: chrome.runtime.getURL('icons/icon128.png'),
                title: `Moss updated ${count === 1 ? 'a script' : `${count} scripts`}`,
                message: summary.updated.join('\n'),
            });
        }
        return summary;
    })().finally(function () {
        updating = null;
    });
    return updating;
}

// ---------- messages from Moss's own pages ----------

/*
 * status() -> { user_scripts, sync_status, script_errors }
 */
async function status() {
    const available = await user_scripts_available();
    const got = await chrome.storage.session.get(['sync_status', 'script_errors']);
    // "Allow User Scripts" was just switched on: register everything now.
    if (available && got.sync_status && !got.sync_status.user_scripts) {
        schedule_sync();
    }
    return { user_scripts: available, sync_status: got.sync_status, script_errors: got.script_errors || {} };
}

/*
 * clear_errors(id) — forget a script's runtime errors
 */
async function clear_errors(id) {
    const got = await chrome.storage.session.get('script_errors');
    const errors = got.script_errors || {};
    delete errors[id];
    await chrome.storage.session.set({ script_errors: errors });
    if (Object.keys(errors).length === 0) {
        await chrome.action.setBadgeText({ text: '' });
    }
    return true;
}

/*
 * runner_scripts() -> what the offscreen runner should run
 */
async function runner_scripts() {
    const st = await get_state();
    const built = await build_all();
    return { scripts: built.background, keepalive: st.settings['runtime.keepalive'] };
}

const HANDLERS = {
    'status': status,
    'sync': function () {
        schedule_sync();
        return true;
    },
    'menu.list': function (msg) {
        return host.list_menus(msg.tab_id);
    },
    'menu.run': function (msg) {
        return host.run_menu(msg.conn, msg.id);
    },
    'errors.clear': function (msg) {
        return clear_errors(msg.id);
    },
    'updates.run': function () {
        return run_updates({ all: true });
    },
    'runner.scripts': runner_scripts,
};

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    const from_moss = sender.id === chrome.runtime.id && sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
    if (!from_moss || !msg || msg.target) {
        return undefined;
    }
    const handler = HANDLERS[msg.type];
    if (handler === undefined) {
        return undefined;
    }
    Promise.resolve(handler(msg, sender)).then(function (value) {
        respond({ ok: true, value: value });
    }, function (e) {
        respond({ ok: false, error: e.message });
    });
    return true;
});

// ---------- lifecycle ----------

/*
 * seed_examples() — install the example scripts and module (disabled), in one write
 */
async function seed_examples() {
    const scripts = {};
    for (const file of EXAMPLES) {
        const id = new_id();
        scripts[id] = { id: id, code: await load_text(`src/examples/${file}`), enabled: false, options: {}, source: null, created_at: Date.now(), updated_at: Date.now() };
    }
    const modules = {};
    for (const name of Object.keys(EXAMPLE_MODULES)) {
        modules[name] = { name: name, code: await load_text(EXAMPLE_MODULES[name]), updated_at: Date.now() };
    }
    await chrome.storage.local.set({ schema_version: SCHEMA_VERSION, scripts: scripts, modules: modules, settings: {} });
}

boot();
chrome.runtime.onInstalled.addListener(async function () {
    await boot();
    schedule_sync();
});
chrome.runtime.onStartup.addListener(schedule_sync);
