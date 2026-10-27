// Keeping imported scripts in step with their source (GitHub or any URL).
// script.source = { url, label, hash, auto, every }  — hash is the SHA-256 of the
// code as last fetched, which tells "changed upstream" apart from "edited here".
import { fetchText } from './github.js';
import { parseMeta } from './meta.js';

export const EVERY_OPTIONS = [
  { value: 15, label: 'every 15 minutes' }, { value: 30, label: 'every 30 minutes' },
  { value: 60, label: 'every hour' }, { value: 180, label: 'every 3 hours' },
  { value: 360, label: 'every 6 hours' }, { value: 720, label: 'every 12 hours' },
  { value: 1440, label: 'every day' }, { value: 10080, label: 'every week' },
];

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export async function newSource(url, label, code, settings = {}) {
  return { url, label, hash: await sha256(code), auto: !!settings['update.autoByDefault'], every: settings['update.every'] || 360 };
}

/**
 * Fetches the source and decides what to do. Never writes anything.
 * → { status: 'current' | 'update' | 'local-changes' | 'not-newer', code?, version?, hash? }
 *   manual: a person asked (skip caches, ignore the "only newer @version" rule).
 */
export async function checkForUpdate(script, { settings = {}, manual = false, fetchImpl } = {}) {
  const src = script.source;
  if (!src?.url) throw new Error('This script has no source to update from.');
  const code = await fetchText(src.url, { token: settings['github.token'], bust: manual, fetchImpl });
  const { meta, errors } = parseMeta(code);
  if (errors.some((e) => e.startsWith('Missing'))) throw new Error('The file at the source has no "// ==UserScript==" header.');

  const hash = await sha256(code);
  const result = { code, hash, version: meta.version };
  if (code === script.code) return { ...result, status: 'current' };
  if (hash === src.hash) return { ...result, status: 'current' }; // unchanged upstream; local edits are kept
  if (src.hash && (await sha256(script.code)) !== src.hash && !(settings['update.overwriteLocal'] && !manual)) {
    return { ...result, status: 'local-changes' };
  }
  if (!manual && settings['update.requireNewerVersion'] && compareVersions(meta.version, parseMeta(script.code).meta.version) <= 0) {
    return { ...result, status: 'not-newer' };
  }
  return { ...result, status: 'update' };
}

export function applyUpdate(script, result) {
  return { ...script, code: result.code, source: { ...script.source, hash: result.hash, updatedAt: Date.now() } };
}
