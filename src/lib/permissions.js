// Asks the browser for the optional permissions a script's grants need.
// Must be called from a user gesture (click / keypress) before any other await.
import { CHROME_PERMISSION } from '../shared/features.js';
import { parseMeta } from './meta.js';

export function permissionsFor(code) {
  const { meta } = parseMeta(code);
  const optional = new Set(chrome.runtime.getManifest().optional_permissions || []);
  const wanted = new Set();
  for (const g of meta.grant) {
    if (g.startsWith('chrome.')) {
      const p = CHROME_PERMISSION[g.slice(7).split('.')[0]];
      if (p) wanted.add(p);
    }
    if (g === 'GM_download') wanted.add('downloads');
  }
  return [...wanted].filter((p) => optional.has(p));
}

// Resolves to the list of permissions that are still missing (empty = all good).
export async function requestPermissionsFor(code) {
  const permissions = permissionsFor(code);
  if (!permissions.length) return [];
  const granted = await chrome.permissions.request({ permissions }).catch(() => false);
  return granted ? [] : permissions;
}
