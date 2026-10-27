// Where bundle ingredients come from inside the extension: packaged files,
// user modules (which may shadow built-ins), and cached @require URLs.
import { BUILTIN_MODULES } from '../shared/features.js';

const texts = new Map();

export function loadText(path) {
  if (!texts.has(path)) {
    texts.set(path, fetch(chrome.runtime.getURL(path)).then((r) => {
      if (!r.ok) throw new Error(`Missing packaged file ${path}`);
      return r.text();
    }));
  }
  return texts.get(path);
}

export async function loadRequire(url, { refresh = false } = {}) {
  const { requireCache = {} } = await chrome.storage.local.get('requireCache');
  if (requireCache[url] && !refresh) return requireCache[url].code;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`@require ${url} failed: HTTP ${res.status}`);
  const code = await res.text();
  requireCache[url] = { code, at: Date.now() };
  await chrome.storage.local.set({ requireCache });
  return code;
}

export function createSources(userModules = {}) {
  return {
    text: loadText,
    async module(name) {
      if (userModules[name]) return userModules[name].code;
      return BUILTIN_MODULES[name] ? loadText(BUILTIN_MODULES[name]) : null;
    },
    require: loadRequire,
    async binary(path) {
      return new Uint8Array(await (await fetch(chrome.runtime.getURL(path))).arrayBuffer());
    },
  };
}
