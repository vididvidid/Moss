'use strict';
/*
 * Keeping imported scripts in step with their source (GitHub or any URL).
 *
 * struct source {
 *     url: string;          raw file URL that is fetched
 *     label: string;        how it is shown ("me/repo/file.js")
 *     hash: string;         SHA-256 of the code as last fetched — tells "changed
 *                           upstream" apart from "edited here"
 *     auto: boolean;        auto-update on/off
 *     every: number;        minutes between auto checks
 *     updated_at: number;   when the code last came from the source
 *     from_header: boolean; built from @updateURL / @downloadURL (see header_source),
 *                           not stored; updates only when @version goes up
 * }
 *
 * struct update_check {
 *     status: 'current' | 'update' | 'local-changes' | 'not-newer';
 *     code, hash, version: string;
 * }
 */
import { fetch_text } from './github.js';
import { MISSING_HEADER, parse_meta } from './meta.js';

export const EVERY_OPTIONS = [
    { value: 15, label: 'every 15 minutes' }, { value: 30, label: 'every 30 minutes' },
    { value: 60, label: 'every hour' }, { value: 180, label: 'every 3 hours' },
    { value: 360, label: 'every 6 hours' }, { value: 720, label: 'every 12 hours' },
    { value: 1440, label: 'every day' }, { value: 10080, label: 'every week' },
];

/*
 * sha256(text) -> lowercase hex SHA-256 of text
 */
export async function sha256(text) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    let hex = '';
    for (let i = 0; i < digest.length; i++) {
        hex += digest[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/*
 * version_numbers(version) -> [1, 2, 3] for "1.2.3" (non-numbers count as 0)
 */
function version_numbers(version) {
    const parts = String(version || '0').split(/[.-]/);
    const out = [];
    for (const part of parts) {
        out.push(parseInt(part, 10) || 0);
    }
    return out;
}

/*
 * compare_versions(a, b) -> 1 if a > b, -1 if a < b, 0 if equal
 */
export function compare_versions(a, b) {
    const pa = version_numbers(a);
    const pb = version_numbers(b);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) {
            return Math.sign(d);
        }
    }
    return 0;
}

/*
 * source_create(url, label, code, settings) -> struct source for freshly imported code
 */
export async function source_create(url, label, code, settings) {
    const s = settings || {};
    return {
        url: url,
        label: label,
        hash: await sha256(code),
        auto: !!s['update.auto_by_default'],
        every: s['update.every'] || 360,
    };
}

/*
 * header_urls(meta) -> { version_url, code_url } from @updateURL / @downloadURL, or null.
 * Like Tampermonkey: @updateURL may be a ".meta.js" holding only the header, and a
 * missing @downloadURL is the same URL ending in ".user.js".
 */
function header_urls(meta) {
    const update_url = /^https:\/\//.test(meta.update_url) ? meta.update_url : '';
    const download_url = /^https:\/\//.test(meta.download_url) ? meta.download_url : '';
    if (update_url === '' && download_url === '') {
        return null;
    }
    let code_url = download_url;
    if (code_url === '') {
        code_url = update_url.replace(/\.meta\.js(?=$|[?#])/, '.user.js');
    }
    return { version_url: update_url !== '' ? update_url : code_url, code_url: code_url };
}

/*
 * header_source(script, settings) -> a struct source from the script's own @updateURL /
 * @downloadURL, for scripts that were not imported from a link; null when it has none
 * or Settings → Updates turns these checks off
 */
export function header_source(script, settings) {
    const s = settings || {};
    if (script.source || s['update.header_urls'] === false) {
        return null;
    }
    const urls = header_urls(parse_meta(script.code).meta);
    if (urls === null) {
        return null;
    }
    return {
        url: urls.code_url, version_url: urls.version_url, label: urls.code_url, hash: '',
        auto: true, every: s['update.every'] || 360, from_header: true,
    };
}

/*
 * effective_source(script, settings) -> where the script updates from, or null
 */
export function effective_source(script, settings) {
    if (script.source && script.source.url) {
        return script.source;
    }
    return header_source(script, settings);
}

/*
 * check_header_update(script, src, options) -> struct update_check for a script that
 * updates from its own @updateURL / @downloadURL: only a higher @version counts
 */
async function check_header_update(script, src, options) {
    const settings = options.settings || {};
    const fetch_opts = { token: settings['github.token'], bust: !!options.manual, fetch_impl: options.fetch_impl };
    const version_text = await fetch_text(src.version_url, fetch_opts);
    const remote = parse_meta(version_text).meta.version;
    const result = { status: 'current', code: script.code, hash: '', version: remote };
    if (compare_versions(remote, parse_meta(script.code).meta.version) <= 0) {
        return result;
    }
    const code = src.version_url === src.url ? version_text : await fetch_text(src.url, fetch_opts);
    if (parse_meta(code).errors.indexOf(MISSING_HEADER) >= 0) {
        throw new Error(`The file at ${src.url} has no script header.`);
    }
    result.status = 'update';
    result.code = code;
    result.hash = await sha256(code);
    result.version = parse_meta(code).meta.version;
    return result;
}

/*
 * check_for_update(script, opts) -> struct update_check. Never writes anything.
 *   opts.settings: resolved settings; opts.manual: a person asked (skip caches,
 *   ignore the "only newer @version" rule); opts.fetch_impl: fetch replacement for tests.
 */
export async function check_for_update(script, opts) {
    const options = opts || {};
    const settings = options.settings || {};
    const src = effective_source(script, settings);
    if (src === null) {
        throw new Error('This script has no source to update from.');
    }
    if (src.from_header) {
        return check_header_update(script, src, options);
    }
    const code = await fetch_text(src.url, { token: settings['github.token'], bust: !!options.manual, fetch_impl: options.fetch_impl });
    const parsed = parse_meta(code);
    if (parsed.errors.indexOf(MISSING_HEADER) >= 0) {
        throw new Error('The file at the source has no script header ("// ==UserScript==" or "// ==Moss==").');
    }

    const hash = await sha256(code);
    const result = { status: 'current', code: code, hash: hash, version: parsed.meta.version };
    if (code === script.code || hash === src.hash) {
        // Unchanged upstream (local edits, if any, are kept).
        return result;
    }
    const edited_here = src.hash && (await sha256(script.code)) !== src.hash;
    const may_overwrite = settings['update.overwrite_local'] && !options.manual;
    if (edited_here && !may_overwrite) {
        result.status = 'local-changes';
        return result;
    }
    if (!options.manual && settings['update.require_newer_version']) {
        if (compare_versions(parsed.meta.version, parse_meta(script.code).meta.version) <= 0) {
            result.status = 'not-newer';
            return result;
        }
    }
    result.status = 'update';
    return result;
}

/*
 * apply_update(script, check) -> a copy of script holding the fetched code
 */
export function apply_update(script, check) {
    if (!script.source) {
        // Updated from its own @downloadURL: it keeps updating from the header.
        return Object.assign({}, script, { code: check.code });
    }
    const source = Object.assign({}, script.source, { hash: check.hash, updated_at: Date.now() });
    return Object.assign({}, script, { code: check.code, source: source });
}
