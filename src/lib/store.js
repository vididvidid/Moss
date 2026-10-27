// chrome.storage.local layout:
//   scripts  { [id]: { id, code, enabled, options, source?, createdAt, updatedAt } }
//   modules  { [name]: { name, code, updatedAt } }   — names like "utils/text"
//   settings { [key]: value }                         — see settings.js
//   tokens   { [id]: secret }                         — authenticates script ports
//   values:<id>                                       — a script's GM values
//   updates  { [id]: { checkedAt, status, error } }   — last source check (see updater.js)
const area = chrome.storage.local;
const read = async (key, fallback) => (await area.get(key))[key] ?? fallback;

export const loadScripts = () => read('scripts', {});
export const loadModules = () => read('modules', {});
export const loadSettingsRaw = () => read('settings', {});

export function newId() {
  return 's' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export async function putScript(script) {
  const scripts = await loadScripts();
  scripts[script.id] = { options: {}, ...script, updatedAt: Date.now() };
  await area.set({ scripts });
  return scripts[script.id];
}

export async function patchScript(id, patch) {
  const scripts = await loadScripts();
  if (!scripts[id]) return null;
  scripts[id] = { ...scripts[id], ...patch, updatedAt: Date.now() };
  await area.set({ scripts });
  return scripts[id];
}

export async function removeScript(id) {
  const scripts = await loadScripts();
  delete scripts[id];
  await area.set({ scripts });
  await area.remove(`values:${id}`);
}

export async function putModule(name, code) {
  const modules = await loadModules();
  modules[name] = { name, code, updatedAt: Date.now() };
  await area.set({ modules });
}

export async function removeModule(name) {
  const modules = await loadModules();
  delete modules[name];
  await area.set({ modules });
}

export async function saveSettings(settings) {
  await area.set({ settings });
}

export async function tokensFor(ids) {
  const tokens = await read('tokens', {});
  let changed = false;
  for (const id of ids) if (!tokens[id]) { tokens[id] = crypto.randomUUID(); changed = true; }
  if (changed) await area.set({ tokens });
  return tokens;
}

export async function loadValues(id) {
  return read(`values:${id}`, {});
}
export async function saveValues(id, values) {
  await area.set({ [`values:${id}`]: values });
}

// Last update check per script — kept apart from `scripts` so a check doesn't
// trigger a rebuild of every script.
export async function recordUpdate(id, info) {
  const updates = await read('updates', {});
  updates[id] = { ...updates[id], ...info, checkedAt: Date.now() };
  await area.set({ updates });
}
export const loadUpdates = () => read('updates', {});
