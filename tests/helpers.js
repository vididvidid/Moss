'use strict';
/*
 * Test helpers: filesystem-backed bundle sources and a fake chrome for running bundles in a VM.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BUILTIN_MODULES } from '../src/shared/features.js';

const ROOT = new URL('../', import.meta.url);

/*
 * read(path) -> text of a repo file
 */
export function read(path) {
    return readFileSync(new URL(path, ROOT), 'utf8');
}

/*
 * fs_sources(user_modules) -> struct sources reading from the repo
 */
export function fs_sources(user_modules) {
    const modules = user_modules || {};
    return {
        text: async function (path) {
            return read(path);
        },
        module: async function (name) {
            if (modules[name] !== undefined) {
                return modules[name];
            }
            return BUILTIN_MODULES[name] !== undefined ? read(BUILTIN_MODULES[name]) : null;
        },
        require: async function (url) {
            return `/* stub for ${url} */ var required_lib = 42;`;
        },
        binary: async function (path) {
            return new Uint8Array(readFileSync(new URL(path, ROOT)));
        },
    };
}

/*
 * event_create() -> a fake chrome event with emit()
 */
function event_create() {
    const fns = [];
    return {
        fns: fns,
        addListener: function (fn) {
            fns.push(fn);
        },
        removeListener: function (fn) {
            const i = fns.indexOf(fn);
            if (i >= 0) {
                fns.splice(i, 1);
            }
        },
        emit: function () {
            for (const fn of fns.slice()) {
                fn.apply(null, arguments);
            }
        },
    };
}

/*
 * port_create(name) -> one end of a fake runtime port (peer is set by port_pair)
 */
function port_create(name) {
    return { name: name, onMessage: event_create(), onDisconnect: event_create(), peer: null };
}

/*
 * port_pair(name) -> [client, server], two connected fake ports
 */
export function port_pair(name) {
    const a = port_create(name);
    const b = port_create(name);
    a.postMessage = function (msg) {
        queueMicrotask(function () {
            b.onMessage.emit(structuredClone(msg));
        });
    };
    b.postMessage = function (msg) {
        queueMicrotask(function () {
            a.onMessage.emit(structuredClone(msg));
        });
    };
    return [a, b];
}

/*
 * recorder(calls, name, result) -> an async fake API function that logs its calls
 */
function recorder(calls, name, result) {
    return async function () {
        const args = Array.prototype.slice.call(arguments);
        calls.push([name].concat(args));
        return typeof result === 'function' ? result.apply(null, args) : result;
    };
}

/*
 * fake_chrome(calls) -> the parts of chrome.* the tests need; calls collects API calls
 */
export function fake_chrome(calls) {
    const log = calls || [];
    const store = {};
    return {
        store: store,
        runtime: { id: 'test', getURL: function (p) { return `chrome-extension://test/${p}`; }, onConnect: event_create(), onMessage: event_create(), lastError: undefined },
        storage: {
            local: {
                get: async function (key) {
                    const out = {};
                    if (key in store) {
                        out[key] = structuredClone(store[key]);
                    }
                    return out;
                },
                set: async function (patch) {
                    Object.assign(store, structuredClone(patch));
                },
            },
        },
        notifications: { create: recorder(log, 'notifications.create', 'n1'), onClicked: event_create(), onClosed: event_create() },
        browsingData: { remove: recorder(log, 'browsingData.remove') },
        history: { deleteUrl: recorder(log, 'history.deleteUrl'), search: recorder(log, 'history.search', []), onVisited: event_create() },
        tabs: {
            create: recorder(log, 'tabs.create', { id: 7 }),
            remove: recorder(log, 'tabs.remove'),
            query: recorder(log, 'tabs.query', []),
        },
    };
}

/*
 * run_in_vm(code, globals) -> the VM context after running code (sloppy script, like a page)
 */
export function run_in_vm(code, globals) {
    const ctx = vm.createContext(Object.assign({
        console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
        clearInterval: clearInterval, queueMicrotask: queueMicrotask, URL: URL, Promise: Promise,
        structuredClone: structuredClone, AbortController: AbortController,
    }, globals));
    ctx.globalThis = ctx;
    vm.runInContext(code, ctx);
    return ctx;
}

/*
 * tick(ms) -> Promise resolved after ms (default 10)
 */
export function tick(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms === undefined ? 10 : ms);
    });
}
