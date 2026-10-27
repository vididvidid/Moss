// Userscript metadata: parsing, normalisation and URL targeting.

const LIST_KEYS = ['match', 'include', 'exclude', 'exclude-match', 'grant', 'require', 'resource', 'connect', 'use'];
const TEXT_KEYS = { name: 'name', namespace: 'namespace', version: 'version', description: 'description', author: 'author',
  icon: 'icon', iconurl: 'icon', folder: 'folder', updateurl: 'updateURL', downloadurl: 'downloadURL',
  homepage: 'homepage', homepageurl: 'homepage' };

const SANDBOX_ALIASES = {
  isolated: 'isolated', dom: 'isolated', sandbox: 'isolated', userscript: 'isolated',
  page: 'page', none: 'page', raw: 'page', main: 'page', javascript: 'page',
  extension: 'extension', native: 'extension', background: 'extension', privileged: 'extension',
};
export const SANDBOXES = ['isolated', 'page', 'extension'];

const RUN_AT = { 'document-start': 'document_start', 'document-end': 'document_end',
  'document-body': 'document_end', 'document-idle': 'document_idle' };
export const RUN_AT_VALUES = Object.keys(RUN_AT).filter((k) => k !== 'document-body');

export function parseMeta(code) {
  const meta = { name: '', namespace: '', version: '0.1.0', description: '', author: '', icon: '', folder: '',
    updateURL: '', downloadURL: '', homepage: '', sandbox: 'isolated', runAt: 'document_idle',
    noframes: false, inject: 'wrapped', extra: {} };
  for (const k of LIST_KEYS) meta[k] = [];
  const errors = [];
  const warnings = [];

  const block = /\/\/[ \t]*==UserScript==([\s\S]*?)\/\/[ \t]*==\/UserScript==/.exec(code || '');
  if (!block) {
    errors.push('Missing the "// ==UserScript==" … "// ==/UserScript==" header.');
    return { meta, errors, warnings };
  }

  let explicitSandbox = false;
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^\s*\/\/[ \t]*@([\w:.-]+)(?:[ \t]+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = (m[2] || '').trim();
    if (LIST_KEYS.includes(key)) {
      if (val) meta[key].push(val);
    } else if (key in TEXT_KEYS) {
      meta[TEXT_KEYS[key]] = val;
    } else if (key === 'sandbox') {
      const s = SANDBOX_ALIASES[val.toLowerCase()];
      if (s) { meta.sandbox = s; explicitSandbox = true; } else warnings.push(`Unknown @sandbox "${val}" — using "isolated".`);
    } else if (key === 'run-at') {
      if (RUN_AT[val]) meta.runAt = RUN_AT[val]; else warnings.push(`Unsupported @run-at "${val}" — using document-idle.`);
    } else if (key === 'noframes') {
      meta.noframes = true;
    } else if (key === 'inject') {
      meta.inject = val === 'raw' ? 'raw' : 'wrapped';
    } else {
      meta.extra[key] = val; // unknown keys are kept, never dropped
    }
  }

  // Tampermonkey compatibility: "@grant none" means "run in the page".
  if (!explicitSandbox && meta.grant.includes('none')) meta.sandbox = 'page';
  meta.grant = meta.grant.filter((g) => g !== 'none');

  meta.use = meta.use.map((v) => {
    const m = /^(\S+)(?:\s+as\s+(\S+))?$/.exec(v);
    if (!m) { errors.push(`Can't read "@use ${v}" — expected "@use path/to/module [as name]".`); return null; }
    if (m[2] && !/^[A-Za-z_$][\w$]*$/.test(m[2])) errors.push(`"${m[2]}" in "@use ${v}" is not a valid variable name.`);
    return { name: m[1], alias: m[2] || null };
  }).filter(Boolean);

  for (const p of [...meta.match, ...meta['exclude-match']]) {
    if (!isMatchPattern(p)) errors.push(`"${p}" is not a valid match pattern (e.g. https://*.example.com/*).`);
  }
  if (!meta.name) errors.push('@name is required.');
  return { meta, errors, warnings };
}

// ---------- URL rules ----------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const MATCH_RE = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*:]+|[^/*:]+)?(?::(?:\d+|\*))?(\/.*)$/;
const REGEX_RULE = /^\/(.+)\/([a-z]*)$/;

export function isMatchPattern(p) {
  return p === '<all_urls>' || MATCH_RE.test(p);
}

function matchPatternSource(p) {
  if (p === '<all_urls>') return '^(?:https?|wss?|ftp|file)://';
  const m = MATCH_RE.exec(p);
  if (!m) return '(?!)';
  const [, scheme, host = '', path] = m;
  const s = scheme === '*' ? 'https?' : esc(scheme);
  const h = host === '*' ? '[^/]*' : host.startsWith('*.') ? `(?:[^/]*\\.)?${esc(host.slice(2))}` : esc(host);
  return `^${s}://${h}(?::\\d+)?${path.split('*').map(esc).join('.*')}$`;
}

// [source, flags] for one @include/@exclude rule: /regex/flags or a * glob.
function ruleSource(rule) {
  const r = REGEX_RULE.exec(rule);
  if (r) return [r[1], r[2].replace('g', '')];
  return [`^${rule.split('*').map(esc).join('.*')}$`, ''];
}

export function compileFilter(meta, extra = {}) {
  return {
    include: [
      ...[...meta.match, ...(extra.matches || [])].map((p) => [matchPatternSource(p), '']),
      ...meta.include.map(ruleSource),
    ],
    exclude: [
      ...meta['exclude-match'].map((p) => [matchPatternSource(p), '']),
      ...[...meta.exclude, ...(extra.excludes || [])].map(ruleSource),
    ],
  };
}

export function urlMatches(meta, url, extra = {}) {
  const f = compileFilter(meta, extra);
  const test = ([s, fl]) => { try { return new RegExp(s, fl).test(url); } catch { return false; } };
  return f.include.some(test) && !f.exclude.some(test);
}

// Where and when a page script is injected. Chrome ANDs `matches` with `include_globs`
// while userscripts OR them, so mixed or regex rules fall back to a runtime URL filter.
export function targets(meta, opt = {}) {
  const matches = [...meta.match, ...(opt.matches || [])];
  const excludes = [...meta.exclude, ...(opt.excludes || [])];
  const runAt = opt.runAt ? RUN_AT[opt.runAt] || meta.runAt : meta.runAt;
  const allFrames = opt.allFrames === 'yes' ? true : opt.allFrames === 'no' ? false : !meta.noframes;
  const base = { runAt, allFrames };

  const hasRegex = [...meta.include, ...excludes].some((r) => REGEX_RULE.test(r));
  if (hasRegex || (matches.length && meta.include.length)) {
    return { ...base, matches: ['*://*/*'], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
      filter: compileFilter(meta, opt) };
  }
  const globs = meta.include.filter((g) => g !== '*');
  return {
    ...base,
    matches: matches.length ? matches : ['*://*/*'],
    excludeMatches: [...meta['exclude-match']],
    includeGlobs: globs,
    excludeGlobs: excludes,
    filter: null,
  };
}
