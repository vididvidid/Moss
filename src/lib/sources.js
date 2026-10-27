'use strict';
/*
 * Where bundle ingredients come from inside the extension: packaged files,
 * user modules (which may shadow built-ins), and cached @require / @resource URLs.
 *
 * struct sources {                       the interface plan()/build() read from
 *     text(path) -> Promise<string>;     a packaged file
 *     module(name) -> Promise<string|null>;
 *     require(url) -> Promise<string>;   an @require library
 *     resource(url) -> Promise<{ mime, data }>;   an @resource file, data in base64
 *     binary(path) -> Promise<Uint8Array>;
 * }
 *
 * Subresource integrity: a URL ending in "#sha256=<hash>" (also sha384 / sha512 / sha1,
 * hex or base64, several joined with "," or ";") is checked when it is downloaded, as in
 * Tampermonkey. md5 hashes can't be checked with Web Crypto and are skipped.
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

const SRI_ALGORITHMS = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

/*
 * sri_hashes(url) -> [{ algorithm, value }] from the URL's "#sha256=…" fragment
 */
export function sri_hashes(url) {
    const at = url.indexOf('#');
    if (at < 0) {
        return [];
    }
    const out = [];
    for (const part of url.slice(at + 1).split(/[,;]/)) {
        const m = /^\s*(md5|sha1|sha256|sha384|sha512)[=-](.+?)\s*$/i.exec(part);
        if (m !== null) {
            out.push({ algorithm: m[1].toLowerCase(), value: m[2] });
        }
    }
    return out;
}

/*
 * to_hex(bytes) -> lowercase hex of a byte array
 */
function to_hex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

/*
 * to_base64(bytes) -> base64 of a byte array
 */
export function to_base64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/*
 * check_integrity(url, bytes) — throw if the download doesn't match a hash in the URL
 */
export async function check_integrity(url, bytes) {
    for (const hash of sri_hashes(url)) {
        const algorithm = SRI_ALGORITHMS[hash.algorithm];
        if (algorithm === undefined) {
            continue; // md5: not available in Web Crypto
        }
        const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
        const wanted = hash.value;
        if (wanted.toLowerCase() !== to_hex(digest) && wanted !== to_base64(digest)) {
            throw new Error(`${url.split('#')[0]} does not match its ${hash.algorithm} hash — the file changed or was tampered with`);
        }
    }
}

/*
 * download(url, what, opts) -> bytes of url, integrity-checked unless opts.sri is 'ignore'
 */
async function download(url, what, opts) {
    const res = await fetch(url.split('#')[0]);
    if (!res.ok) {
        throw new Error(`${what} ${url} failed: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!opts || opts.sri !== 'ignore') {
        await check_integrity(url, bytes);
    }
    return { bytes: bytes, mime: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

/*
 * load_require(url, opts) -> code of an @require library, fetched once and cached
 *   opts: { refresh: boolean, sri: 'validate' | 'ignore' }
 */
export async function load_require(url, opts) {
    const refresh = !!(opts && opts.refresh);
    const got = await chrome.storage.local.get('require_cache');
    const cache = got.require_cache || {};
    if (cache[url] !== undefined && !refresh) {
        return cache[url].code;
    }
    const file = await download(url, '@require', opts);
    const code = new TextDecoder().decode(file.bytes);
    cache[url] = { code: code, at: Date.now() };
    await chrome.storage.local.set({ require_cache: cache });
    return code;
}

/*
 * guess_mime(url) -> a MIME type from the file extension, for servers that send none
 */
function guess_mime(url) {
    const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
    const TYPES = {
        css: 'text/css', js: 'text/javascript', json: 'application/json', html: 'text/html', txt: 'text/plain',
        svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    };
    if (ext !== null && TYPES[ext[1].toLowerCase()] !== undefined) {
        return TYPES[ext[1].toLowerCase()];
    }
    return 'application/octet-stream';
}

/*
 * load_resource(url, opts) -> { mime, data } of an @resource file (data in base64),
 * fetched once and cached
 */
export async function load_resource(url, opts) {
    const refresh = !!(opts && opts.refresh);
    const got = await chrome.storage.local.get('resource_cache');
    const cache = got.resource_cache || {};
    if (cache[url] !== undefined && !refresh) {
        return { mime: cache[url].mime, data: cache[url].data };
    }
    const file = await download(url, '@resource', opts);
    let mime = file.mime;
    if (mime === '' || mime === 'application/octet-stream' || mime === 'text/plain') {
        const guessed = guess_mime(url);
        if (guessed !== 'application/octet-stream') {
            mime = guessed;
        }
    }
    const entry = { mime: mime || 'application/octet-stream', data: to_base64(file.bytes), at: Date.now() };
    cache[url] = entry;
    await chrome.storage.local.set({ resource_cache: cache });
    return { mime: entry.mime, data: entry.data };
}

/*
 * load_binary(path) -> bytes of a file packaged with the extension
 */
async function load_binary(path) {
    const res = await fetch(chrome.runtime.getURL(path));
    return new Uint8Array(await res.arrayBuffer());
}

/*
 * sources_create(user_modules, settings) -> struct sources backed by the extension and
 * user_modules; settings['security.sri'] decides whether hashes are checked
 */
export function sources_create(user_modules, settings) {
    const modules = user_modules || {};
    const fetch_opts = { sri: settings ? settings['security.sri'] : 'validate' };
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
        require: function (url) {
            return load_require(url, fetch_opts);
        },
        resource: function (url) {
            return load_resource(url, fetch_opts);
        },
        binary: load_binary,
    };
}
