// Moss service worker: keeps chrome.userScripts in sync with storage, runs the
// background runner for extension-mode scripts, and hosts the privileged API.
import './shared/host/core.js';
import './shared/host/values.js';
import './shared/host/xhr.js';
import './shared/host/notify.js';
import './shared/host/menu.js';
import './shared/host/tabs.js';
import './shared/host/download.js';
import './shared/host/chrome.js';
import { build, plan } from './lib/bundler.js';
import { parseMeta } from './lib/meta.js';
import { createSources, loadText } from './lib/sources.js';
import { loadModules, loadScripts, loadSettingsRaw, loadUpdates, putModule, putScript, newId, recordUpdate, tokensFor } from './lib/store.js';
import { applyUpdate, checkForUpdate } from './lib/updater.js';
import { permissionsFor } from './lib/permissions.js';
import { hostPolicy, resolveSettings } from './lib/settings.js';

const RUNNER = 'src/runner/offscreen.html';
const EXAMPLES = ['page-tools.user.js', 'fetch-logger.user.js'];
const EXAMPLE_MODULES = { 'utils/text': 'src/examples/utils-text.js' };

// ---------- state ----------

let state = null;
function getState() {
  state ??= (async () => {
    const [scripts, modules, settings] = await Promise.all([loadScripts(), loadModules(), loadSettingsRaw()]);
    const resolved = resolveSettings(settings);
    host.policy = hostPolicy(resolved);
    const tokens = await tokensFor(Object.keys(scripts));
    const metas = Object.fromEntries(Object.values(scripts).map((s) => [s.id, parseMeta(s.code).meta]));
    return { scripts, modules, settings: resolved, tokens, metas };
  })();
  return state;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.scripts || changes.modules || changes.settings)) return;
  state = null;
  scheduleSync();
});

// ---------- privileged API host ----------

const host = MossHost({
  icon: chrome.runtime.getURL('icons/icon128.png'),
  onError: recordError,
  async getScript(conn) {
    const st = await getState();
    const s = st.scripts[conn.scriptId];
    if (!s?.enabled) return null;
    if (!conn.trusted && st.tokens[s.id] !== conn.token) return null;
    const meta = st.metas[s.id];
    return { id: s.id, name: meta.name, grants: meta.grant, connect: meta.connect };
  },
});

// Runtime errors per script (latest first), shown in the popup and dashboard.
let errorWrites = Promise.resolve();
function recordError(script, message) {
  errorWrites = errorWrites.then(async () => {
    const { scriptErrors = {} } = await chrome.storage.session.get('scriptErrors');
    scriptErrors[script.id] = [{ at: Date.now(), message }, ...(scriptErrors[script.id] || [])].slice(0, 5);
    await chrome.storage.session.set({ scriptErrors });
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    await chrome.action.setBadgeText({ text: '!' });
  }).catch(() => {});
}

// Sandboxed scripts connect from the USER_SCRIPT world…
chrome.runtime.onUserScriptConnect?.addListener((port) => {
  const [kind, scriptId, token] = port.name.split(':');
  if (kind !== 'moss') return port.disconnect();
  host.attachPort(port, { scriptId, token, tabId: port.sender?.tab?.id ?? null, url: port.sender?.url });
});
// …and background scripts through the offscreen runner.
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.url !== chrome.runtime.getURL(RUNNER) || !port.name.startsWith('moss-bg:')) return;
  host.attachPort(port, { scriptId: port.name.slice('moss-bg:'.length), trusted: true, tabId: null });
});

// ---------- building & registering ----------

async function userScriptsAvailable() {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

async function buildAll() {
  const st = await getState();
  const sources = createSources(st.modules);
  const out = { pageScripts: [], background: [], errors: {} };
  for (const s of Object.values(st.scripts)) {
    if (!s.enabled) continue;
    try {
      const p = await plan(s, { sources, settings: st.settings, target: 'moss' });
      if (p.errors.length) throw new Error(p.errors.join('\n'));
      const code = await build(p, { sources, script: s, token: st.tokens[s.id], settings: st.settings });
      if (p.mode === 'extension') { out.background.push({ id: s.id, code }); continue; }
      const t = p.targets;
      const reg = { id: s.id, js: [{ code }], matches: t.matches, runAt: t.runAt, allFrames: t.allFrames,
        world: p.mode === 'page' || p.inject === 'raw' ? 'MAIN' : 'USER_SCRIPT' };
      if (t.excludeMatches.length) reg.excludeMatches = t.excludeMatches;
      if (t.includeGlobs.length) reg.includeGlobs = t.includeGlobs;
      if (t.excludeGlobs.length) reg.excludeGlobs = t.excludeGlobs;
      out.pageScripts.push(reg);
    } catch (e) {
      out.errors[s.id] = e.message;
    }
  }
  return out;
}

async function hasRunner() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

let creatingRunner = null;
async function syncRunner(scripts, keepalive) {
  const exists = await hasRunner();
  if (!scripts.length) {
    if (exists) await chrome.offscreen.closeDocument();
    return;
  }
  if (exists) {
    await chrome.runtime.sendMessage({ target: 'runner', type: 'load', value: { scripts, keepalive } }).catch(() => {});
    return;
  }
  // A fresh runner asks for its scripts itself ("runner.scripts").
  creatingRunner ??= chrome.offscreen.createDocument({
    url: RUNNER,
    reasons: ['IFRAME_SCRIPTING'],
    justification: 'Runs extension-mode user scripts inside sandboxed iframes.',
  }).finally(() => { creatingRunner = null; });
  await creatingRunner;
}

async function sync() {
  const st = await getState();
  const built = await buildAll();
  const available = await userScriptsAvailable();
  if (available) {
    await chrome.userScripts.configureWorld({ messaging: true });
    await chrome.userScripts.unregister();
    // One at a time, so one bad script can't block the others.
    for (const reg of built.pageScripts) {
      try {
        await chrome.userScripts.register([reg]);
      } catch (e) {
        built.errors[reg.id] = `Could not register: ${e.message}`;
      }
    }
  }
  await syncRunner(built.background, st.settings['runtime.keepalive']);
  // Scripts were rebuilt, so earlier runtime errors are stale.
  await chrome.storage.session.set({ syncStatus: { at: Date.now(), userScripts: available, errors: built.errors }, scriptErrors: {} });
  await chrome.action.setBadgeText({ text: '' });
}

let syncTimer = null;
let syncing = Promise.resolve();
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncing = syncing.then(sync).catch((e) => console.error('Moss sync failed', e)); }, 150);
}

// ---------- updates from GitHub / URLs ----------

const UPDATE_ALARM = 'moss-updates';
chrome.alarms.get(UPDATE_ALARM).then((a) => a || chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 5, delayInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === UPDATE_ALARM) runUpdates(); });

let updating = null;
// due: only scripts with auto-update on whose interval has passed; otherwise every script with a source.
function runUpdates({ all = false } = {}) {
  updating ??= (async () => {
    const st = await getState();
    const updates = await loadUpdates();
    const summary = { checked: 0, updated: [], errors: [] };
    for (const s of Object.values(st.scripts)) {
      if (!s.source?.url) continue;
      const every = (s.source.every || st.settings['update.every']) * 60e3;
      if (!all && (!s.source.auto || Date.now() - (updates[s.id]?.checkedAt || 0) < every)) continue;
      summary.checked++;
      const name = st.metas[s.id].name;
      try {
        const r = await checkForUpdate(s, { settings: st.settings, manual: all });
        if (r.status !== 'update') {
          await recordUpdate(s.id, { status: r.status, error: null });
          continue;
        }
        await putScript(applyUpdate(s, r));
        const missing = [];
        for (const p of permissionsFor(r.code)) if (!(await chrome.permissions.contains({ permissions: [p] }))) missing.push(p);
        await recordUpdate(s.id, { status: 'updated', version: r.version, updatedAt: Date.now(),
          error: missing.length ? `Updated, but it now needs the ${missing.join(', ')} permission — open it and click Save.` : null });
        summary.updated.push(`${name} ${r.version}`);
      } catch (e) {
        await recordUpdate(s.id, { status: 'error', error: e.message });
        summary.errors.push(`${name}: ${e.message}`);
      }
    }
    if (summary.updated.length && st.settings['update.notify']) {
      chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `Moss updated ${summary.updated.length === 1 ? 'a script' : `${summary.updated.length} scripts`}`, message: summary.updated.join('\n') });
    }
    return summary;
  })().finally(() => { updating = null; });
  return updating;
}

// ---------- messages from Moss's own pages ----------

const handlers = {
  async status() {
    const available = await userScriptsAvailable();
    const { syncStatus, scriptErrors = {} } = await chrome.storage.session.get(['syncStatus', 'scriptErrors']);
    // "Allow User Scripts" was just switched on: register everything now.
    if (available && syncStatus && !syncStatus.userScripts) scheduleSync();
    return { userScripts: available, syncStatus, scriptErrors };
  },
  sync() { scheduleSync(); return true; },
  'menu.list': ({ tabId }) => host.listMenus(tabId),
  'menu.run': ({ conn, id }) => host.runMenu(conn, id),
  'updates.run': () => runUpdates({ all: true }),
  async 'errors.clear'({ id }) {
    const { scriptErrors = {} } = await chrome.storage.session.get('scriptErrors');
    delete scriptErrors[id];
    await chrome.storage.session.set({ scriptErrors });
    if (!Object.keys(scriptErrors).length) await chrome.action.setBadgeText({ text: '' });
    return true;
  },
  async 'runner.scripts'() {
    const st = await getState();
    return { scripts: (await buildAll()).background, keepalive: st.settings['runtime.keepalive'] };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || msg?.target) return;
  const handler = handlers[msg?.type];
  if (!handler) return;
  Promise.resolve(handler(msg, sender)).then(
    (value) => respond({ ok: true, value }),
    (e) => respond({ ok: false, error: e.message }));
  return true;
});

// ---------- lifecycle ----------

async function seedExamples() {
  for (const file of EXAMPLES) {
    const code = await loadText(`src/examples/${file}`);
    await putScript({ id: newId(), code, enabled: false, createdAt: Date.now() });
  }
  for (const [name, path] of Object.entries(EXAMPLE_MODULES)) await putModule(name, await loadText(path));
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await seedExamples();
  scheduleSync();
});
chrome.runtime.onStartup.addListener(scheduleSync);
