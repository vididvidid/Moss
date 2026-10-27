// Turns a script into injectable code. `plan()` decides everything (mode, features,
// modules, permissions) without generating code, so the dashboard, Moss itself and
// the exporter all agree on what a script needs. `build()` assembles the bundle.
import { parseMeta, targets } from './meta.js';
import { ALL_API, CHROME_PERMISSION, FEATURES, RUNTIME_CORE, runtimeFeature, runtimeTransport } from '../shared/features.js';

export const MOSS_VERSION = '0.1.0';
const REQUIRE_RE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export function findRequires(src) {
  return [...src.matchAll(REQUIRE_RE)].map((m) => m[2]);
}

export function slugify(name) {
  return String(name || 'script').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script';
}

/**
 * sources: { text(path), module(name) -> src | null, require(url) -> src }
 * target:  'moss' (inject through Moss) or 'export' (standalone extension)
 */
export async function plan(script, { sources, settings, target = 'moss' }) {
  const { meta, errors, warnings } = parseMeta(script.code);
  const opt = script.options || {};
  const mode = opt.sandbox || meta.sandbox;
  const inject = opt.inject || meta.inject;
  const raw = inject === 'raw';

  // Module graph: @use lines first, then require('…') calls, depth-first.
  const modules = [];
  const seen = new Set();
  const visit = async (name, from) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = await sources.module(name);
    if (src == null) { errors.push(`Module "${name}" not found (needed by ${from}).`); return; }
    for (const dep of findRequires(src)) await visit(dep, `module ${name}`);
    modules.push({ name, src });
  };
  if (!raw) {
    for (const u of meta.use) await visit(u.name, '@use');
    for (const r of findRequires(script.code)) await visit(r, 'the script');
  }

  // Features: forced in options, granted, or mentioned in the script / a module.
  const features = [];
  if (!raw) {
    for (const [name, f] of Object.entries(FEATURES)) {
      const forced = opt.features?.[name];
      if (forced === 'exclude') continue;
      let reason = forced === 'include' ? 'forced in script options' : null;
      if (!reason && f.detect.test(script.code)) reason = 'used by the script';
      if (!reason) {
        const m = modules.find((mod) => f.detect.test(mod.src));
        if (m) reason = `used by module ${m.name}`;
      }
      if (!reason) {
        const g = meta.grant.find((gr) => f.grants?.includes(gr) || (f.grantPrefix && gr.startsWith(f.grantPrefix)));
        if (g) reason = `@grant ${g}`;
      }
      if (reason) features.push({ name, reason });
    }
  }
  const has = (n) => features.some((f) => f.name === n);

  // Which features run on the privileged side, and how the script talks to it.
  const nativeChrome = target === 'export' && mode === 'extension';
  const bridged = mode !== 'page' && !raw;
  const valuesLocal = settings?.['runtime.valuesBackend'] === 'local';
  const hostFeatures = !bridged ? [] : features.map((f) => f.name).filter((n) =>
    FEATURES[n].host && !(n === 'chrome' && nativeChrome) && !(n === 'values' && valuesLocal));
  if (!bridged && !raw) {
    for (const f of features) {
      if (FEATURES[f.name].host && !['values', 'tabs'].includes(f.name)) {
        warnings.push(`${FEATURES[f.name].label} (${f.name}) won't work in page mode — it needs the extension bridge.`);
      }
    }
  }
  let transport = 'none';
  if (hostFeatures.length) transport = mode === 'extension' ? (target === 'export' ? 'direct' : 'window') : 'port';

  // chrome.* grants
  const allowed = settings?.['security.chromeNamespaces'];
  const chromeNs = [...new Set(meta.grant.filter((g) => g.startsWith('chrome.')).map((g) => g.slice(7).split('.')[0]))];
  for (const ns of chromeNs) {
    if (allowed && !allowed.includes(ns)) errors.push(`chrome.${ns} is not enabled (Settings → Security).`);
  }
  if (has('chrome') && mode === 'page') errors.push('moss.chrome is not available in page mode.');

  // Permissions, each with the reason it is needed.
  const permissions = new Map();
  const hostPermissions = new Map();
  for (const n of hostFeatures) for (const p of FEATURES[n].permissions || []) permissions.set(p, `${n} feature`);
  if (has('chrome')) for (const ns of chromeNs) if (CHROME_PERMISSION[ns]) permissions.set(CHROME_PERMISSION[ns], `@grant chrome.${ns}`);
  if (hostFeatures.includes('xhr')) {
    const hosts = meta.connect.filter((c) => c !== 'self');
    if (!hosts.length || hosts.includes('*')) hostPermissions.set('<all_urls>', 'GM_xmlhttpRequest without a specific @connect');
    else for (const h of hosts) { hostPermissions.set(`*://${h}/*`, `@connect ${h}`); hostPermissions.set(`*://*.${h}/*`, `@connect ${h}`); }
  }

  const aliases = Object.fromEntries(meta.use.filter((u) => u.alias).map((u) => [u.alias, u.name]));
  for (const a of Object.keys(aliases)) if (ALL_API.includes(a)) errors.push(`"@use … as ${a}" clashes with a built-in API name.`);

  return {
    meta, errors, warnings, mode, inject, target, modules, features, hostFeatures, transport, nativeChrome,
    needsPopup: hostFeatures.includes('menu'),
    permissions: [...permissions].map(([name, reason]) => ({ name, reason })),
    hostPermissions: [...hostPermissions].map(([name, reason]) => ({ name, reason })),
    targets: mode === 'extension' ? null : targets(meta, opt),
    aliases,
    delay: Number(opt.delay) || 0,
  };
}

export async function build(p, { sources, script, token, settings }) {
  const slug = slugify(p.meta.name);
  if (p.inject === 'raw') return `${script.code}\n//# sourceURL=moss/${slug}.user.js`;

  const parts = [await sources.text(RUNTIME_CORE)];
  const ctx = {
    id: script.id,
    token: token || '',
    mode: p.mode,
    target: p.target,
    version: MOSS_VERSION,
    info: {
      name: p.meta.name, namespace: p.meta.namespace, version: p.meta.version, description: p.meta.description,
      author: p.meta.author, grants: p.meta.grant, matches: p.meta.match, runAt: p.meta.runAt,
    },
    features: p.features.map((f) => f.name),
    params: [...ALL_API, ...Object.keys(p.aliases)],
    aliases: p.aliases,
    filter: p.targets?.filter || null,
    delay: p.delay,
    nativeChrome: p.nativeChrome,
    sync: p.nativeChrome,
    logErrors: settings?.['runtime.logErrors'] !== false,
    logPrefix: settings?.['runtime.logPrefix'] || 'Moss',
    valuesBackend: settings?.['runtime.valuesBackend'] || 'extension',
  };
  const transport = p.transport === 'none' ? '' : await sources.text(runtimeTransport(p.transport));
  const feats = await Promise.all(p.features.map((f) => sources.text(runtimeFeature(f.name))));
  const requires = await Promise.all(p.meta.require.map(async (url) => `// @require ${url}\n${await sources.require(url)}`));
  const modules = p.modules.map((m) =>
    `M.define(${JSON.stringify(m.name)}, function (module, exports, require, api) {\n${m.src}\n});`);

  return [
    `// ${p.meta.name} — bundled by Moss ${MOSS_VERSION} (${p.mode}, features: ${ctx.features.join(', ') || 'none'})`,
    '(function () {',
    ...parts,
    `var M = MossCore(${JSON.stringify(ctx)});`,
    'if (!M) return;',
    transport,
    ...feats,
    ...modules,
    `M.start(async function (${ctx.params.join(', ')}) {`,
    ...requires,
    script.code,
    '});',
    '})();',
    `//# sourceURL=moss/${slug}.user.js`,
  ].filter((s) => s !== '').join('\n');
}
