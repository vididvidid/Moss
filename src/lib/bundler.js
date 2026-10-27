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
 *     transport: 'port' | 'window' | 'direct' | 'none';
 *     native_chrome: boolean;                    moss.chrome is the real chrome object
 *     needs_popup: boolean;
 *     permissions, host_permissions: { name, reason }[];
 *     targets: struct targets | null;            null for extension mode
 *     aliases: { [alias]: module name };
 *     delay: number;
 * }
 */
import { parse_meta, targets } from './meta.js';
import { ALL_API, CHROME_PERMISSION, FEATURES, RUNTIME_CORE, runtime_feature, runtime_transport } from '../shared/features.js';

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
    if (mode !== 'extension') {
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
    const opt = script.options || {};
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
    const bridged = mode !== 'page' && !raw;
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
    if (!bridged && !raw) {
        for (const name of feature_names) {
            if (FEATURES[name].host && name !== 'values' && name !== 'tabs') {
                warnings.push(`${FEATURES[name].label} (${name}) won't work in page mode — it needs the extension bridge.`);
            }
        }
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
    if (feature_names.includes('chrome') && mode === 'page') {
        errors.push('moss.chrome is not available in page mode.');
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
        transport: pick_transport(mode, target, host_features.length),
        native_chrome: native_chrome,
        needs_popup: host_features.includes('menu'),
        permissions: map_to_list(permissions),
        host_permissions: map_to_list(host_permissions),
        targets: mode === 'extension' ? null : targets(meta, opt),
        aliases: aliases,
        delay: Number(opt.delay) || 0,
    };
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
 * build(plan, { sources, script, token, settings }) -> the code to inject
 */
export async function build(p, args) {
    const sources = args.sources;
    const script = args.script;
    const settings = args.settings || {};
    const slug = slugify(p.meta.name);
    const strict_line = p.strict ? '\'use strict\';' : '';
    if (p.inject === 'raw') {
        return [strict_line, script.code, `//# sourceURL=moss/${slug}.user.js`].join('\n');
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
            description: p.meta.description, author: p.meta.author, grant: p.meta.grant,
            matches: p.meta.match, 'run-at': p.meta.run_at.replace('_', '-'),
        },
        features: feature_names,
        params: ALL_API.concat(Object.keys(p.aliases)),
        aliases: p.aliases,
        filter: p.targets === null ? null : p.targets.filter,
        delay: p.delay,
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
    parts.push(script.code, '});', '})();', `//# sourceURL=moss/${slug}.user.js`);
    return parts.join('\n');
}
