'use strict';
/*
 * Userscript metadata: parsing, normalisation and URL targeting.
 *
 * struct meta {
 *     name, namespace, version, description, author, icon, folder: string;
 *     update_url, download_url, homepage: string;
 *     sandbox: 'isolated' | 'page' | 'extension';
 *     run_at: 'document_start' | 'document_end' | 'document_idle';
 *     noframes: boolean;
 *     inject: 'wrapped' | 'raw';
 *     strict: boolean;                 // @strict: run the script in strict mode
 *     match, include, exclude, exclude_match, grant, require, resource, connect: string[];
 *     use: { name: string; alias: string|null }[];
 *     extra: { [key: string]: string };  // unknown header keys, kept
 * }
 */

// Header key → field of struct meta, for keys that may repeat.
const LIST_KEYS = {
    'match': 'match', 'include': 'include', 'exclude': 'exclude', 'exclude-match': 'exclude_match',
    'grant': 'grant', 'require': 'require', 'resource': 'resource', 'connect': 'connect', 'use': 'use',
};
// Header key → field of struct meta, for single-value keys.
const TEXT_KEYS = {
    name: 'name', namespace: 'namespace', version: 'version', description: 'description', author: 'author',
    icon: 'icon', iconurl: 'icon', folder: 'folder', updateurl: 'update_url', downloadurl: 'download_url',
    homepage: 'homepage', homepageurl: 'homepage',
};

const SANDBOX_ALIASES = {
    isolated: 'isolated', dom: 'isolated', sandbox: 'isolated', userscript: 'isolated',
    page: 'page', none: 'page', raw: 'page', main: 'page', javascript: 'page',
    extension: 'extension', native: 'extension', background: 'extension', privileged: 'extension',
};
export const SANDBOXES = ['isolated', 'page', 'extension'];

const RUN_AT = {
    'document-start': 'document_start',
    'document-end': 'document_end',
    'document-body': 'document_end',
    'document-idle': 'document_idle',
};
export const RUN_AT_VALUES = ['document-start', 'document-end', 'document-idle'];

/*
 * meta_create() -> a struct meta holding the defaults
 */
function meta_create() {
    const meta = {
        name: '', namespace: '', version: '0.1.0', description: '', author: '', icon: '', folder: '',
        update_url: '', download_url: '', homepage: '', sandbox: 'isolated', run_at: 'document_idle',
        noframes: false, inject: 'wrapped', strict: false, extra: {},
    };
    for (const key of Object.keys(LIST_KEYS)) {
        meta[LIST_KEYS[key]] = [];
    }
    return meta;
}

/*
 * parse_use(value, errors) -> { name, alias } for one "@use path [as name]" line, or null
 */
function parse_use(value, errors) {
    const m = /^(\S+)(?:\s+as\s+(\S+))?$/.exec(value);
    if (m === null) {
        errors.push(`Can't read "@use ${value}" — expected "@use path/to/module [as name]".`);
        return null;
    }
    if (m[2] && !/^[A-Za-z_$][\w$]*$/.test(m[2])) {
        errors.push(`"${m[2]}" in "@use ${value}" is not a valid variable name.`);
    }
    return { name: m[1], alias: m[2] || null };
}

/*
 * apply_key(meta, key, value, warnings) -> true if key set the sandbox explicitly
 */
function apply_key(meta, key, value, warnings) {
    if (key in LIST_KEYS) {
        if (value !== '') {
            meta[LIST_KEYS[key]].push(value);
        }
        return false;
    }
    if (key in TEXT_KEYS) {
        meta[TEXT_KEYS[key]] = value;
        return false;
    }
    switch (key) {
    case 'sandbox': {
        const sandbox = SANDBOX_ALIASES[value.toLowerCase()];
        if (sandbox === undefined) {
            warnings.push(`Unknown @sandbox "${value}" — using "isolated".`);
            return false;
        }
        meta.sandbox = sandbox;
        return true;
    }
    case 'run-at':
        if (RUN_AT[value] === undefined) {
            warnings.push(`Unsupported @run-at "${value}" — using document-idle.`);
        } else {
            meta.run_at = RUN_AT[value];
        }
        return false;
    case 'noframes':
        meta.noframes = true;
        return false;
    case 'strict':
        meta.strict = value !== 'off' && value !== 'false' && value !== 'no';
        return false;
    case 'inject':
        meta.inject = value === 'raw' ? 'raw' : 'wrapped';
        return false;
    default:
        meta.extra[key] = value; // unknown keys are kept, never dropped
        return false;
    }
}

/*
 * parse_meta(code) -> { meta, errors, warnings }
 */
export function parse_meta(code) {
    const meta = meta_create();
    const errors = [];
    const warnings = [];

    const block = /\/\/[ \t]*==UserScript==([\s\S]*?)\/\/[ \t]*==\/UserScript==/.exec(code || '');
    if (block === null) {
        errors.push('Missing the "// ==UserScript==" … "// ==/UserScript==" header.');
        return { meta: meta, errors: errors, warnings: warnings };
    }

    let explicit_sandbox = false;
    for (const line of block[1].split(/\r?\n/)) {
        const m = /^\s*\/\/[ \t]*@([\w:.-]+)(?:[ \t]+(.*?))?\s*$/.exec(line);
        if (m === null) {
            continue;
        }
        const value = m[2] === undefined ? '' : m[2].trim();
        if (apply_key(meta, m[1].toLowerCase(), value, warnings)) {
            explicit_sandbox = true;
        }
    }

    // Tampermonkey compatibility: "@grant none" means "run in the page".
    const grants = [];
    for (const grant of meta.grant) {
        if (grant === 'none') {
            if (!explicit_sandbox) {
                meta.sandbox = 'page';
            }
        } else {
            grants.push(grant);
        }
    }
    meta.grant = grants;

    const uses = [];
    for (const value of meta.use) {
        const use = parse_use(value, errors);
        if (use !== null) {
            uses.push(use);
        }
    }
    meta.use = uses;

    for (const pattern of meta.match.concat(meta.exclude_match)) {
        if (!is_match_pattern(pattern)) {
            errors.push(`"${pattern}" is not a valid match pattern (e.g. https://*.example.com/*).`);
        }
    }
    if (meta.name === '') {
        errors.push('@name is required.');
    }
    return { meta: meta, errors: errors, warnings: warnings };
}

// ---------- URL rules ----------

const MATCH_RE = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*:]+|[^/*:]+)?(?::(?:\d+|\*))?(\/.*)$/;
const REGEX_RULE = /^\/(.+)\/([a-z]*)$/;

/*
 * escape_regex(text) -> text with every regex special character escaped
 */
function escape_regex(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/*
 * star_source(text) -> regex source where each * matches anything and the rest is literal
 */
function star_source(text) {
    const parts = text.split('*');
    for (let i = 0; i < parts.length; i++) {
        parts[i] = escape_regex(parts[i]);
    }
    return parts.join('.*');
}

/*
 * is_match_pattern(pattern) -> true for a valid Chrome match pattern
 */
export function is_match_pattern(pattern) {
    return pattern === '<all_urls>' || MATCH_RE.test(pattern);
}

/*
 * match_pattern_source(pattern) -> regex source equivalent to a match pattern
 */
function match_pattern_source(pattern) {
    if (pattern === '<all_urls>') {
        return '^(?:https?|wss?|ftp|file)://';
    }
    const m = MATCH_RE.exec(pattern);
    if (m === null) {
        return '(?!)';
    }
    const scheme = m[1] === '*' ? 'https?' : escape_regex(m[1]);
    const host = m[2] === undefined ? '' : m[2];
    let host_source = escape_regex(host);
    if (host === '*') {
        host_source = '[^/]*';
    } else if (host.startsWith('*.')) {
        host_source = `(?:[^/]*\\.)?${escape_regex(host.slice(2))}`;
    }
    return `^${scheme}://${host_source}(?::\\d+)?${star_source(m[3])}$`;
}

/*
 * rule_source(rule) -> [source, flags] for one @include/@exclude rule (/regex/flags or a * glob)
 */
function rule_source(rule) {
    const r = REGEX_RULE.exec(rule);
    if (r !== null) {
        return [r[1], r[2].replace('g', '')];
    }
    return [`^${star_source(rule)}$`, ''];
}

/*
 * compile_filter(meta, extra) -> { include: [source, flags][], exclude: [source, flags][] }
 */
export function compile_filter(meta, extra) {
    const more = extra || {};
    const include = [];
    const exclude = [];
    for (const pattern of meta.match.concat(more.matches || [])) {
        include.push([match_pattern_source(pattern), '']);
    }
    for (const rule of meta.include) {
        include.push(rule_source(rule));
    }
    for (const pattern of meta.exclude_match) {
        exclude.push([match_pattern_source(pattern), '']);
    }
    for (const rule of meta.exclude.concat(more.excludes || [])) {
        exclude.push(rule_source(rule));
    }
    return { include: include, exclude: exclude };
}

/*
 * rule_matches(rule, url) -> true if the [source, flags] rule matches url
 */
function rule_matches(rule, url) {
    try {
        return new RegExp(rule[0], rule[1]).test(url);
    } catch (e) {
        return false;
    }
}

/*
 * url_matches(meta, url, extra) -> true if the script runs on url
 */
export function url_matches(meta, url, extra) {
    const filter = compile_filter(meta, extra);
    let included = false;
    for (const rule of filter.include) {
        if (rule_matches(rule, url)) {
            included = true;
            break;
        }
    }
    if (!included) {
        return false;
    }
    for (const rule of filter.exclude) {
        if (rule_matches(rule, url)) {
            return false;
        }
    }
    return true;
}

/*
 * targets(meta, opt) -> where and when a page script is injected
 *
 * Chrome ANDs `matches` with `include_globs` while userscripts OR them, so mixed or
 * regex rules fall back to a runtime URL filter.
 *
 * struct targets {
 *     run_at: string; all_frames: boolean;
 *     matches, exclude_matches, include_globs, exclude_globs: string[];
 *     filter: { include, exclude } | null;
 * }
 */
export function targets(meta, opt) {
    const options = opt || {};
    const matches = meta.match.concat(options.matches || []);
    const excludes = meta.exclude.concat(options.excludes || []);

    let run_at = meta.run_at;
    if (options.run_at && RUN_AT[options.run_at] !== undefined) {
        run_at = RUN_AT[options.run_at];
    }
    let all_frames = !meta.noframes;
    if (options.all_frames === 'yes') {
        all_frames = true;
    } else if (options.all_frames === 'no') {
        all_frames = false;
    }

    let has_regex = false;
    for (const rule of meta.include.concat(excludes)) {
        if (REGEX_RULE.test(rule)) {
            has_regex = true;
        }
    }
    if (has_regex || (matches.length > 0 && meta.include.length > 0)) {
        return {
            run_at: run_at, all_frames: all_frames, matches: ['*://*/*'], exclude_matches: [],
            include_globs: [], exclude_globs: [], filter: compile_filter(meta, options),
        };
    }

    const globs = [];
    for (const glob of meta.include) {
        if (glob !== '*') {
            globs.push(glob);
        }
    }
    return {
        run_at: run_at,
        all_frames: all_frames,
        matches: matches.length > 0 ? matches : ['*://*/*'],
        exclude_matches: meta.exclude_match.slice(),
        include_globs: globs,
        exclude_globs: excludes,
        filter: null,
    };
}
