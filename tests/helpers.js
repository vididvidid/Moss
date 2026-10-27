// Test helpers: filesystem-backed bundle sources and a fake chrome for running bundles in a VM.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BUILTIN_MODULES } from '../src/shared/features.js';

const ROOT = new URL('../', import.meta.url);
export const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

export function fsSources(userModules = {}) {
  return {
    text: async (path) => read(path),
    module: async (name) => userModules[name] ?? (BUILTIN_MODULES[name] ? read(BUILTIN_MODULES[name]) : null),
    require: async (url) => `/* stub for ${url} */ var requiredLib = 42;`,
    binary: async (path) => new Uint8Array(readFileSync(new URL(path, ROOT))),
  };
}

function event() {
  const fns = [];
  return {
    fns,
    addListener: (f) => fns.push(f),
    removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); },
    emit: (...a) => fns.forEach((f) => f(...a)),
  };
}

// A connected pair of fake runtime ports.
export function portPair(name) {
  const a = { name, onMessage: event(), onDisconnect: event() };
  const b = { name, onMessage: event(), onDisconnect: event() };
  a.postMessage = (m) => queueMicrotask(() => b.onMessage.emit(structuredClone(m)));
  b.postMessage = (m) => queueMicrotask(() => a.onMessage.emit(structuredClone(m)));
  return [a, b];
}

export function fakeChrome(calls = []) {
  const store = {};
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  return {
    store,
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onConnect: event(), onMessage: event(), lastError: undefined },
    storage: { local: {
      get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
      set: async (o) => Object.assign(store, structuredClone(o)),
    } },
    notifications: { create: rec('notifications.create', 'n1'), onClicked: event(), onClosed: event() },
    browsingData: { remove: rec('browsingData.remove') },
    history: { deleteUrl: rec('history.deleteUrl'), search: rec('history.search', []), onVisited: event() },
    tabs: {
      create: rec('tabs.create', { id: 7 }),
      remove: rec('tabs.remove'),
      query: rec('tabs.query', [
        { id: 1, pinned: false, lastAccessed: Date.now() - 2 * 60e3 },     // used 2 min ago
        { id: 2, pinned: false, lastAccessed: Date.now() - 3 * 3600e3 },   // used 3 h ago
        { id: 3, pinned: true, lastAccessed: Date.now() },                 // pinned
      ]),
    },
  };
}

export function runInVm(code, globals) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, Promise, structuredClone, AbortController, ...globals });
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx);
  return ctx;
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
