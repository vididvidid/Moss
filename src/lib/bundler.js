'use strict';
/*
 * Turns a script into injectable code. plan() decides everything (mode, features,
 * modules, permissions) without generating code, so the dashboard, Moss itself and
 * the exporter all agree on what a script needs. build() assembles the bundle.
 *
 * struct plan {
 *     meta: struct meta; errors, warnings: string[];
 *     mode: 'isolated' | 'page' | 'extension'; inject: 'wrapped' | 'raw';
 *     target: 'moss' | 'export';
 *     strict: boolean;                           user code runs in strict mode
 *     modules: { name, src }[];                  in dependency order
 *     features: { name, reason }[];
 *     host_features: string[];                   features that need the privileged side
 *     transport: 'port' | 'window' | 'direct' | 'relay' | 'none';
 *     inject_at: string;                         when Chrome injects it (page mode with a relay: document_start)
 *     native_chrome: boolean;                    moss.chrome is the real chrome object
 *     needs_popup: boolean;
 *     permissions, host_permissions: { name, reason }[];
 *     targets: struct targets | null;            null for extension mode
 *     aliases: { [alias]: module name };
 *     delay: number;
 *     early: boolean;                            document_start + values: start at once from a
 *                                                values snapshot instead of waiting for them
 *     context_menu: boolean;                     @run-at context-menu: run from the right-click menu
 * }
 */
import { file_extension } from './formats.js';
import { meta_block, parse_meta, parse_resources, targets } from './meta.js';
import { ALL_API, CHROME_PERMISSION, FEATURES, RUNTIME_CORE, RUNTIME_RELAY, runtime_feature, runtime_transport } from '../shared/features.js';

export const MOSS_VERSION = '0.2.0';
const REQUIRE_RE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/*
 * find_requires(src) -> module names passed to require('…') in src
 */
export function find_requires(src) {
    const names = [];
    for (const m of src.matchAll(REQUIRE_RE)) {
        names.push(m[2]);
    }
    return names;
}

/*
 * slugify(name) -> "my-script" for "My Script!"
 */
export function slugify(name) {
    const slug = String(name || 'script').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug === '' ? 'script' : slug;
}

/*
 * collect_modules(script, meta, sources, errors) -> [{ name, src }], dependencies first
 */
async function collect_modules(script, meta, sources, errors) {
    const modules = [];
    const seen = new Set();

    /*
     * visit(name, from) — add name and, before it, everything it requires
     */
    async function visit(name, from) {
        if (seen.has(name)) {
            return;
        }
        seen.add(name);
        const src = await sources.module(name);
        if (src === null || src === undefined) {
            errors.push(`Module "${name}" not found (needed by ${from}).`);
            return;
        }
        for (const dep of find_requires(src)) {
            await visit(dep, `module ${name}`);
        }
        modules.push({ name: name, src: src });
    }

    for (const use of meta.use) {
        await visit(use.name, '@use');
    }
    for (const name of find_requires(script.code)) {
        await visit(name, 'the script');
    }
    return modules;
}

/*
 * feature_reason(name, script, meta, modules, forced) -> why a feature is included, or null
 */
function feature_reason(name, script, meta, modules, forced) {
    const feature = FEATURES[name];
    if (forced === 'include') {
        return 'forced in script options';
    }
    if (feature.detect.test(script.code)) {
        return 'used by the script';
    }
    for (const mod of modules) {
        if (feature.detect.test(mod.src)) {
            return `used by module ${mod.name}`;
        }
    }
    for (const grant of meta.grant) {
        const by_grant = feature.grants !== undefined && feature.grants.includes(grant);
        const by_prefix = feature.grant_prefix !== undefined && grant.startsWith(feature.grant_prefix);
        if (by_grant || by_prefix) {
            return `@grant ${grant}`;
        }
    }
    return null;
}

/*
 * pick_transport(mode, target, host_count) -> how the script talks to the privileged side
 */
function pick_transport(mode, target, host_count) {
    if (host_count === 0) {
        return 'none';
    }
    if (mode === 'page') {
        return 'relay';
    }
    if (mode === 'isolated') {
        return 'port';
    }
    return target === 'export' ? 'direct' : 'window';
}

/*
 * is_strict(meta, opt, settings) -> true if the user's code should run in strict mode
 */
function is_strict(meta, opt, settings) {
    if (opt.strict === 'yes') {
        return true;
    }
    if (opt.strict === 'no') {
        return false;
    }
    return meta.strict || !!(settings && settings['runtime.strict_default']);
}

/*
 * plan(script, { sources, settings, target }) -> struct plan
 *   sources: struct sources (see sources.js); target: 'moss' or 'export'
 */
export async function plan(script, args) {
    const sources = args.sources;
    const settings = args.settings || {};
    const target = args.target || 'moss';
    const parsed = parse_meta(script.code);
    const meta = parsed.meta;
    const errors = parsed.errors;
    const warnings = parsed.warnings;
    const opt = with_blocked_pages(script.options || {}, settings);
    const mode = opt.sandbox || meta.sandbox;
    const inject = opt.inject || meta.inject;
    const raw = inject === 'raw';

    const modules = raw ? [] : await collect_modules(script, meta, sources, errors);

    // Features: forced in options, granted, or mentioned in the script / a module.
    const features = [];
    if (!raw) {
        for (const name of Object.keys(FEATURES)) {
            const forced = opt.features ? opt.features[name] : undefined;
            if (forced === 'exclude') {
                continue;
            }
            const reason = feature_reason(name, script, meta, modules, forced);
            if (reason !== null) {
                features.push({ name: name, reason: reason });
            }
        }
    }
    const feature_names = [];
    for (const f of features) {
        feature_names.push(f.name);
    }

    // Which features run on the privileged side, and how the script talks to it.
    const native_chrome = target === 'export' && mode === 'extension';
    const bridged = !raw;
    const values_local = settings['runtime.values_backend'] === 'local';
    const host_features = [];
    for (const name of feature_names) {
        if (!bridged || !FEATURES[name].host) {
            continue;
        }
        if (name === 'chrome' && native_chrome) {
            continue;
        }
        if (name === 'values' && values_local) {
            continue;
        }
        host_features.push(name);
    }

    // chrome.* grants
    const allowed = settings['security.chrome_namespaces'];
    const chrome_ns = [];
    for (const grant of meta.grant) {
        if (grant.startsWith('chrome.')) {
            const ns = grant.slice(7).split('.')[0];
            if (!chrome_ns.includes(ns)) {
                chrome_ns.push(ns);
            }
        }
    }
    for (const ns of chrome_ns) {
        if (allowed && !allowed.includes(ns)) {
            errors.push(`chrome.${ns} is not enabled (Settings → Security).`);
        }
    }

    // Permissions, each with the reason it is needed.
    const permissions = new Map();
    const host_permissions = new Map();
    for (const name of host_features) {
        for (const permission of FEATURES[name].permissions || []) {
            permissions.set(permission, `${name} feature`);
        }
    }
    if (feature_names.includes('chrome')) {
        for (const ns of chrome_ns) {
            if (CHROME_PERMISSION[ns]) {
                permissions.set(CHROME_PERMISSION[ns], `@grant chrome.${ns}`);
            }
        }
    }
    if (host_features.includes('xhr')) {
        const hosts = [];
        for (const c of meta.connect) {
            if (c !== 'self') {
                hosts.push(c);
            }
        }
        if (hosts.length === 0 || hosts.includes('*')) {
            host_permissions.set('<all_urls>', 'GM_xmlhttpRequest without a specific @connect');
        } else {
            for (const h of hosts) {
                host_permissions.set(`*://${h}/*`, `@connect ${h}`);
                host_permissions.set(`*://*.${h}/*`, `@connect ${h}`);
            }
        }
    }

    const aliases = {};
    for (const use of meta.use) {
        if (use.alias !== null) {
            aliases[use.alias] = use.name;
            if (ALL_API.includes(use.alias)) {
                errors.push(`"@use … as ${use.alias}" clashes with a built-in API name.`);
            }
        }
    }

    if (feature_names.includes('resource') && meta.resource.length > parse_resources(meta).length) {
        warnings.push('An @resource line could not be read — expected "@resource name https://…".');
    }

    const transport = pick_transport(mode, target, host_features.length);
    const placed = mode === 'extension' ? null : targets(meta, opt);
    const context_menu = placed !== null && placed.run_at === 'context_menu';
    return {
        meta: meta,
        errors: errors,
        warnings: warnings,
        mode: mode,
        inject: inject,
        target: target,
        strict: is_strict(meta, opt, settings),
        modules: modules,
        features: features,
        host_features: host_features,
        transport: transport,
        inject_at: placed === null ? null : (transport === 'relay' ? 'document_start' : placed.run_at),
        native_chrome: native_chrome,
        needs_popup: host_features.includes('menu'),
        permissions: map_to_list(permissions),
        host_permissions: map_to_list(host_permissions),
        targets: placed,
        aliases: aliases,
        delay: Number(opt.delay) || 0,
        early: placed !== null && placed.run_at === 'document_start' && host_features.includes('values'),
        context_menu: context_menu,
    };
}

/*
 * with_blocked_pages(opt, settings) -> the script options plus the global
 * "Never run scripts on these pages" list as extra excludes
 */
export function with_blocked_pages(opt, settings) {
    const blocked = settings ? settings['security.blocked_pages'] : null;
    if (!blocked || blocked.length === 0) {
        return opt;
    }
    return Object.assign({}, opt, { excludes: (opt.excludes || []).concat(blocked) });
}

/*
 * bundle_resources(p, sources) -> { [name]: { url, mime, data } } for the script's
 * @resource files; one that can't be fetched is left out and logged
 */
async function bundle_resources(p, sources) {
    const out = {};
    if (!sources.resource) {
        return out;
    }
    for (const res of parse_resources(p.meta)) {
        try {
            const file = await sources.resource(res.url);
            out[res.name] = { url: res.url, mime: file.mime, data: file.data };
        } catch (e) {
            console.warn(`Moss: @resource ${res.name}: ${e.message}`);
        }
    }
    return out;
}

/*
 * map_to_list(map) -> [{ name, reason }] from a Map of name → reason
 */
function map_to_list(map) {
    const out = [];
    for (const [name, reason] of map) {
        out.push({ name: name, reason: reason });
    }
    return out;
}

/*
 * build(plan, { sources, script, token, settings, values }) -> the code to inject
 *   values: the script's stored GM values, baked in when plan.early so the script can
 *   start before the page's own scripts without waiting for them
 */
export async function build(p, args) {
    const sources = args.sources;
    const script = args.script;
    const settings = args.settings || {};
    const slug = slugify(p.meta.name);
    const source_url = `//# sourceURL=moss/${slug}${file_extension(p.meta.format)}`;
    const strict_line = p.strict ? '\'use strict\';' : '';
    if (p.inject === 'raw') {
        return [strict_line, script.code, source_url].join('\n');
    }

    const feature_names = [];
    for (const f of p.features) {
        feature_names.push(f.name);
    }
    const ctx = {
        id: script.id,
        token: args.token || '',
        mode: p.mode,
        target: p.target,
        version: MOSS_VERSION,
        info: {
            name: p.meta.name, namespace: p.meta.namespace, version: p.meta.version,
            description: p.meta.description, author: p.meta.author, copyright: p.meta.copyright,
            icon: p.meta.icon, homepage: p.meta.homepage, supportURL: p.meta.support_url,
            updateURL: p.meta.update_url, downloadURL: p.meta.download_url,
            grant: p.meta.grant, matches: p.meta.match, includes: p.meta.include,
            excludes: p.meta.exclude, 'exclude-match': p.meta.exclude_match, connects: p.meta.connect,
            requires: p.meta.require, tags: p.meta.tag, resources: parse_resources(p.meta),
            'run-at': p.meta.run_at.replace('_', '-'), noframes: p.meta.noframes, sandbox: p.mode,
            options: { inject_into: p.mode, run_at: p.inject_at },
        },
        meta_str: meta_block(script.code),
        will_update: !!(script.source && script.source.auto),
        resources: feature_names.includes('resource') ? await bundle_resources(p, sources) : {},
        features: feature_names,
        params: ALL_API.concat(Object.keys(p.aliases)),
        aliases: p.aliases,
        filter: p.targets === null ? null : p.targets.filter,
        delay: p.delay,
        defer_until: p.transport === 'relay' ? p.targets.run_at : null,
        early: p.early,
        values_snapshot: p.early ? (args.values || {}) : null,
        native_chrome: p.native_chrome,
        sync: p.native_chrome,
        log_errors: settings['runtime.log_errors'] !== false,
        log_prefix: settings['runtime.log_prefix'] || 'Moss',
        values_backend: settings['runtime.values_backend'] || 'extension',
    };

    const parts = [
        `// ${p.meta.name} — bundled by Moss ${MOSS_VERSION} (${p.mode}, features: ${feature_names.join(', ') || 'none'})`,
        '(function () {',
        await sources.text(RUNTIME_CORE),
        `const rt = moss_core(${JSON.stringify(ctx)});`,
        'if (!rt) {',
        '    return;',
        '}',
    ];
    if (p.transport !== 'none') {
        parts.push(await sources.text(runtime_transport(p.transport)));
    }
    for (const name of feature_names) {
        parts.push(await sources.text(runtime_feature(name)));
    }
    for (const mod of p.modules) {
        parts.push(`rt.define(${JSON.stringify(mod.name)}, function (module, exports, require, api) {\n${mod.src}\n});`);
    }
    parts.push(`rt.start(async function (${ctx.params.join(', ')}) {`);
    if (strict_line !== '') {
        parts.push(strict_line);
    }
    for (const url of p.meta.require) {
        parts.push(`// @require ${url}\n${await sources.require(url)}`);
    }
    parts.push(script.code, '});', '})();', source_url);
    return parts.join('\n');
}

/*
 * build_relay(plan, { sources, script, token }) -> the sandboxed-world relay a page-mode
 * script with a bridge needs (injected beside it, at document_start)
 */
export async function build_relay(p, args) {
    const ctx = { id: args.script.id, token: args.token || '' };
    return [
        `// ${p.meta.name} — Moss relay for its page-mode bundle`,
        '(function () {',
        await args.sources.text(RUNTIME_RELAY),
        `moss_relay(${JSON.stringify(ctx)});`,
        '})();',
    ].join('\n');
}
