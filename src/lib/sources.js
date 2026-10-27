'use strict';
/*
 * Where bundle ingredients come from inside the extension: packaged files,
 * user modules (which may shadow built-ins), and cached @require URLs.
 *
 * struct sources {                       the interface plan()/build() read from
 *     text(path) -> Promise<string>;     a packaged file
 *     module(name) -> Promise<string|null>;
 *     require(url) -> Promise<string>;   an @require library
 *     binary(path) -> Promise<Uint8Array>;
 * }
 */
import { BUILTIN_MODULES } from '../shared/features.js';

const TEXTS = new Map(); // path -> Promise<string>, packaged files never change

/*
 * load_text(path) -> text of a file packaged with the extension
 */
export function load_text(path) {
    if (!TEXTS.has(path)) {
        TEXTS.set(path, fetch(chrome.runtime.getURL(path)).then(function (res) {
            if (!res.ok) {
                throw new Error(`Missing packaged file ${path}`);
            }
            return res.text();
        }));
    }
    return TEXTS.get(path);
}

/*
 * load_require(url, opts) -> code of an @require library, fetched once and cached
 */
export async function load_require(url, opts) {
    const refresh = !!(opts && opts.refresh);
    const got = await chrome.storage.local.get('require_cache');
    const cache = got.require_cache || {};
    if (cache[url] !== undefined && !refresh) {
        return cache[url].code;
    }
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`@require ${url} failed: HTTP ${res.status}`);
    }
    const code = await res.text();
    cache[url] = { code: code, at: Date.now() };
    await chrome.storage.local.set({ require_cache: cache });
    return code;
}

/*
 * load_binary(path) -> bytes of a file packaged with the extension
 */
async function load_binary(path) {
    const res = await fetch(chrome.runtime.getURL(path));
    return new Uint8Array(await res.arrayBuffer());
}

/*
 * sources_create(user_modules) -> struct sources backed by the extension and user_modules
 */
export function sources_create(user_modules) {
    const modules = user_modules || {};
    return {
        text: load_text,
        module: async function (name) {
            if (modules[name] !== undefined) {
                return modules[name].code;
            }
            if (BUILTIN_MODULES[name] === undefined) {
                return null;
            }
            return load_text(BUILTIN_MODULES[name]);
        },
        require: load_require,
        binary: load_binary,
    };
}
