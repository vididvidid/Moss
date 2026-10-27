'use strict';
/*
 * Moss service worker: keeps chrome.userScripts in sync with storage, runs the
 * background runner for extension-mode scripts, hosts the privileged API, migrates
 * stored data, and checks imported scripts for updates.
 *
 * struct state {                     cached view of storage, rebuilt after changes
 *     enabled: boolean;              global on/off from the dashboard
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
import './shared/host/window.js';
import './shared/host/tab.js';
import './shared/host/cookie.js';
import { build, build_relay, plan, with_blocked_pages } from './lib/bundler.js';
import { parse_meta, url_matches } from './lib/meta.js';
import { migrate_state, upgrade_examples, SCHEMA_VERSION } from './lib/migrate.js';
import { missing_permissions } from './lib/permissions.js';
import { host_policy, resolve_settings } from './lib/settings.js';
import { load_text, sources_create } from './lib/sources.js';
import { load_modules, load_moss_enabled, load_scripts, load_settings_raw, load_updates, new_id, put_script, record_update, tokens_for } from './lib/store.js';
import { apply_update, check_for_update } from './lib/updater.js';

const RUNNER = 'src/runner/offscreen.html';
const EXAMPLES = ['page-tools.user.js', 'fetch-logger.user.js'];
const EXAMPLE_MODULES = { 'utils/text': 'src/examples/utils-text.js' };
const UPDATE_ALARM = 'moss-updates';
const USER_JS_RE = /^https?:\/\/[^?#]+\.user\.js(?:[?#].*)?$/i;
const BADGE_COLOR = '#2f7d4f';
const ERROR_COLOR = '#c0392b';

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
            const enabled = await load_moss_enabled();
            const scripts = await load_scripts();
            const modules = await load_modules();
            const settings = resolve_settings(await load_settings_raw());
            host.policy = host_policy(settings);
            const tokens = await tokens_for(Object.keys(scripts));
            const metas = {};
            for (const id of Object.keys(scripts)) {
                metas[id] = parse_meta(scripts[id].code).meta;
            }
            return { enabled: enabled, scripts: scripts, modules: modules, settings: settings, tokens: tokens, metas: metas };
        })();
    }
    return state;
}

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !(changes.scripts || changes.modules || changes.settings || changes.moss_enabled)) {
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
    if (!st.enabled || s === undefined || !s.enabled) {
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
function record_error(script, message, conn) {
    error_writes = error_writes.then(async function () {
        const got = await chrome.storage.session.get('script_errors');
        const errors = got.script_errors || {};
        const list = [{ at: Date.now(), message: message }].concat(errors[script.id] || []);
        errors[script.id] = list.slice(0, 5);
        await chrome.storage.session.set({ script_errors: errors });
        const mode = (await get_state()).settings['popup.badge'];
        const tab_id = conn && conn.tab_id !== null && conn.tab_id !== undefined ? conn.tab_id : null;
        if (mode === 'running' && tab_id !== null) {
            tabs_with_errors.add(tab_id);
            await refresh_badge(tab_id);
        } else if (mode !== 'none') {
            await chrome.action.setBadgeBackgroundColor({ color: ERROR_COLOR });
            await chrome.action.setBadgeText({ text: '!' });
        }
    }).catch(function () {});
}

const snapshot_timers = {};

/*
 * refresh_snapshot(script_id) — a document_start script carries a snapshot of its values;
 * re-register just that script a moment after they change, so the next page load starts
 * with current values
 */
function refresh_snapshot(script_id) {
    clearTimeout(snapshot_timers[script_id]);
    snapshot_timers[script_id] = setTimeout(async function () {
        delete snapshot_timers[script_id];
        try {
            const st = await get_state();
            const s = st.scripts[script_id];
            if (!st.enabled || !s || !s.enabled) {
                return;
            }
            const sources = sources_create(st.modules, st.settings);
            const p = await plan(s, { sources: sources, settings: st.settings, target: 'moss' });
            if (!p.early || p.errors.length > 0) {
                return;
            }
            const values = (await chrome.storage.local.get(`values:${s.id}`))[`values:${s.id}`];
            const code = await build(p, { sources: sources, script: s, token: st.tokens[s.id], settings: st.settings, values: values });
            await chrome.userScripts.update([{ id: s.id, js: [{ code: code }] }]);
        } catch (e) {
            console.error('Moss: could not refresh the values snapshot', e);
        }
    }, 1000);
}

const host = moss_host({
    icon: chrome.runtime.getURL('icons/icon128.png'),
    on_error: record_error,
    on_values_change: refresh_snapshot,
    on_menu_change: function () {
        schedule_menus();
    },
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
 * registration(id, p, code, world, run_at) -> a chrome.userScripts registration on the
 * script's targets
 */
function registration(id, p, code, world, run_at) {
    const t = p.targets;
    const reg = {
        id: id,
        js: [{ code: code }],
        matches: t.matches,
        runAt: run_at,
        allFrames: t.all_frames,
        world: world,
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
 * build_all() -> { page_scripts: registrations, background: [{ id, code }],
 *                  context_menu: [{ id, name, code, world, matches }], errors: { id: message } }
 */
async function build_all() {
    const st = await get_state();
    const sources = sources_create(st.modules, st.settings);
    const out = { page_scripts: [], background: [], context_menu: [], errors: {} };
    if (!st.enabled) {
        return out; // switched off globally: nothing is registered or run
    }
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
            const values = p.early ? (await chrome.storage.local.get(`values:${s.id}`))[`values:${s.id}`] : null;
            const code = await build(p, { sources: sources, script: s, token: st.tokens[s.id], settings: st.settings, values: values });
            if (p.mode === 'extension') {
                out.background.push({ id: s.id, code: code });
                continue;
            }
            const world = (p.mode === 'page' || p.inject === 'raw') ? 'MAIN' : 'USER_SCRIPT';
            if (p.transport === 'relay') {
                // The relay goes first, so it is usually listening before the script starts.
                const relay = await build_relay(p, { sources: sources, script: s, token: st.tokens[s.id] });
                out.page_scripts.push(registration(`${s.id}__relay`, p, relay, 'USER_SCRIPT', 'document_start'));
            }
            if (p.context_menu) {
                // Not injected on load: it runs when picked from the right-click menu.
                out.context_menu.push({ id: s.id, name: p.meta.name, code: code, world: world, matches: p.targets.matches });
                continue;
            }
            out.page_scripts.push(registration(s.id, p, code, world, p.inject_at));
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
                built.errors[reg.id.replace(/__relay$/, '')] = `Could not register: ${e.message}`;
            }
        }
    }
    await sync_runner(built.background, st.settings['runtime.keepalive']);
    context_scripts = built.context_menu;
    // Scripts were rebuilt, so earlier runtime errors are stale.
    await chrome.storage.session.set({
        sync_status: { at: Date.now(), user_scripts: available, errors: built.errors },
        script_errors: {},
    });
    tabs_with_errors.clear();
    await show_enabled_badge(st.enabled);
    await refresh_all_badges();
    schedule_menus();
}

/*
 * show_enabled_badge(enabled) — a grey "off" on the toolbar icon while Moss is switched off
 */
async function show_enabled_badge(enabled) {
    if (enabled) {
        await chrome.action.setBadgeText({ text: '' });
        return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#777777' });
    await chrome.action.setBadgeText({ text: 'off' });
}

// ---------- toolbar badge: scripts running on each tab ----------

const tabs_with_errors = new Set();   // tab ids where a script reported an error

/*
 * running_count(st, url) -> how many enabled page scripts run on url
 */
function running_count(st, url) {
    if (!st.enabled || !/^(https?|file|ftp):/.test(url || '')) {
        return 0;
    }
    let count = 0;
    for (const id of Object.keys(st.scripts)) {
        const s = st.scripts[id];
        const meta = st.metas[id];
        const options = s.options || {};
        const mode = options.sandbox || meta.sandbox;
        if (!s.enabled || mode === 'extension' || meta.run_at === 'context_menu') {
            continue;
        }
        if (url_matches(meta, url, with_blocked_pages(options, st.settings))) {
            count++;
        }
    }
    return count;
}

/*
 * refresh_badge(tab_id) — the per-tab badge when "Toolbar icon badge" is "running"
 */
async function refresh_badge(tab_id) {
    const st = await get_state();
    try {
        if (st.settings['popup.badge'] !== 'running' || !st.enabled) {
            await chrome.action.setBadgeText({ tabId: tab_id, text: null });
            return;
        }
        const tab = await chrome.tabs.get(tab_id);
        const count = running_count(st, tab.url);
        const failed = tabs_with_errors.has(tab_id);
        let text = count > 0 ? String(count) : '';
        if (failed && text === '') {
            text = '!';
        }
        await chrome.action.setBadgeBackgroundColor({ tabId: tab_id, color: failed ? ERROR_COLOR : BADGE_COLOR });
        await chrome.action.setBadgeText({ tabId: tab_id, text: text });
    } catch (e) {
        // tab closed meanwhile
    }
}

/*
 * refresh_all_badges() — recount every open tab
 */
async function refresh_all_badges() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        await refresh_badge(tab.id);
    }
}

chrome.tabs.onUpdated.addListener(function (tab_id, change, tab) {
    if (change.status === 'loading') {
        tabs_with_errors.delete(tab_id);
    }
    if (change.url !== undefined || change.status === 'loading') {
        refresh_badge(tab_id);
    }
    if (change.status === 'complete') {
        schedule_menus();
    }
    if (change.url !== undefined) {
        offer_install(tab_id, change.url, tab);
    }
});
chrome.tabs.onActivated.addListener(function () {
    schedule_menus();
});
chrome.tabs.onRemoved.addListener(function (tab_id) {
    tabs_with_errors.delete(tab_id);
});

// ---------- right-click menu: @run-at context-menu scripts and menu commands ----------

let context_scripts = null;   // [{ id, name, code, world, matches }] from the last sync, null after a restart
let menu_timer = null;
let menu_building = Promise.resolve();   // rebuilds run one after another, never interleaved
let menu_commands = {};       // menu item id -> { conn, id }

/*
 * schedule_menus() — rebuild the right-click menu soon, once
 */
function schedule_menus() {
    clearTimeout(menu_timer);
    menu_timer = setTimeout(function () {
        menu_building = menu_building.then(rebuild_menus).catch(function (e) {
            console.error('Moss: could not build the right-click menu', e);
        });
    }, 120);
}

/*
 * rebuild_menus() — context-menu scripts (on their pages) plus the active tab's menu commands
 */
async function rebuild_menus() {
    if (!chrome.contextMenus) {
        return;
    }
    await chrome.contextMenus.removeAll();
    menu_commands = {};
    const st = await get_state();
    if (!st.enabled) {
        return;
    }
    if (context_scripts === null) {
        context_scripts = (await build_all()).context_menu;
    }
    for (const item of context_scripts) {
        chrome.contextMenus.create({ id: `moss-s:${item.id}`, title: item.name, contexts: ['all'], documentUrlPatterns: item.matches });
    }
    if (!st.settings['menu.context_menu']) {
        return;
    }
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length === 0) {
        return;
    }
    const commands = host.list_menus(tabs[0].id);
    for (let i = 0; i < commands.length; i++) {
        const key = `moss-c:${i}`;
        menu_commands[key] = { conn: commands[i].conn, id: commands[i].id };
        chrome.contextMenus.create({ id: key, title: commands[i].caption, contexts: ['all'] });
    }
}

/*
 * run_context_script(id, tab, frame_id) — inject a @run-at context-menu script now
 */
async function run_context_script(id, tab, frame_id) {
    if (context_scripts === null) {
        context_scripts = (await build_all()).context_menu;
    }
    let item = null;
    for (const candidate of context_scripts) {
        if (candidate.id === id) {
            item = candidate;
        }
    }
    if (item === null) {
        return;
    }
    if (!chrome.userScripts.execute) {
        chrome.notifications.create({
            type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: item.name,
            message: '@run-at context-menu needs Chrome 135 or newer.',
        });
        return;
    }
    await chrome.userScripts.execute({
        target: { tabId: tab.id, frameIds: [frame_id || 0] },
        js: [{ code: item.code }],
        world: item.world,
        injectImmediately: true,
    });
}

if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
        const id = String(info.menuItemId);
        if (id.startsWith('moss-s:')) {
            run_context_script(id.slice(7), tab, info.frameId).catch(function (e) {
                console.error('Moss: context-menu script failed', e);
            });
            return;
        }
        const command = menu_commands[id];
        if (command !== undefined) {
            host.run_menu(command.conn, command.id);
        }
    });
}

// ---------- installing scripts from .user.js links ----------

const offered = {};   // url -> time it was last offered, so a reload doesn't ask again at once

/*
 * offer_install(tab_id, url, tab) — open the install dialog for a userscript link
 */
async function offer_install(tab_id, url, tab) {
    if (!USER_JS_RE.test(url) || url.startsWith(chrome.runtime.getURL(''))) {
        return;
    }
    const st = await get_state();
    if (!st.settings['install.detect_urls']) {
        return;
    }
    if (offered[url] !== undefined && Date.now() - offered[url] < 10e3) {
        return;
    }
    offered[url] = Date.now();
    const create = { url: chrome.runtime.getURL(`src/dashboard/index.html?install=${encodeURIComponent(url)}`), openerTabId: tab_id };
    if (tab && tab.index !== undefined) {
        create.index = tab.index + 1;
    }
    await chrome.tabs.create(create);
}

let sync_timer = null;
let syncing = Promise.resolve();
let sync_waiters = [];     // resolve functions of callers waiting for the next sync

/*
 * schedule_sync() -> Promise that settles once the sync it schedules has finished.
 * Syncs soon, once, however many changes arrive meanwhile.
 */
function schedule_sync() {
    const done = new Promise(function (resolve) {
        sync_waiters.push(resolve);
    });
    clearTimeout(sync_timer);
    sync_timer = setTimeout(function () {
        const waiters = sync_waiters;
        sync_waiters = [];
        syncing = syncing.then(sync).catch(function (e) {
            console.error('Moss sync failed', e);
        }).finally(function () {
            for (const resolve of waiters) {
                resolve(true);
            }
        });
    }, 150);
    return done;
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
        if (!st.enabled && !opts.all) {
            return summary; // no auto-updates while switched off; "Check all now" still works
        }
        for (const id of Object.keys(st.scripts)) {
            const s = st.scripts[id];
            if (!s.source || !s.source.url || s.source.kind === 'local') {
                continue; // local files are watched by the dashboard
            }
            const every = (s.source.every || st.settings['update.every']) * 60e3;
            const last = updates[id] ? updates[id].checked_at : 0;
            if (!opts.all && (!s.source.auto || Date.now() - last < every)) {
                continue;
            }
            if (!opts.all && !s.enabled && !st.settings['update.disabled_scripts']) {
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
        tabs_with_errors.clear();
        await show_enabled_badge((await get_state()).enabled);
        await refresh_all_badges();
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
    // A page just changed scripts and wants to reload a tab once Chrome has the new
    // registrations. Drop the cached state in case storage.onChanged hasn't fired yet.
    'sync.wait': function () {
        state = null;
        return schedule_sync();
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
