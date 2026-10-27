'use strict';
/*
 * Asks the browser for the optional permissions a script's grants need.
 */
import { CHROME_PERMISSION } from '../shared/features.js';
import { parse_meta } from './meta.js';

/*
 * permissions_for(code) -> optional manifest permissions the script's @grant lines need
 */
export function permissions_for(code) {
    const meta = parse_meta(code).meta;
    const optional = chrome.runtime.getManifest().optional_permissions || [];
    const wanted = [];
    for (const grant of meta.grant) {
        let permission = null;
        if (grant.startsWith('chrome.')) {
            permission = CHROME_PERMISSION[grant.slice(7).split('.')[0]];
        } else if (grant === 'GM_download') {
            permission = 'downloads';
        } else if (grant === 'GM_cookie' || grant === 'GM.cookie') {
            permission = 'cookies';
        }
        if (permission && optional.includes(permission) && !wanted.includes(permission)) {
            wanted.push(permission);
        }
    }
    return wanted;
}

/*
 * request_permissions_for(code) -> permissions still missing afterwards (empty = all good).
 * Must be called from a user gesture (click / keypress) before any other await.
 */
export async function request_permissions_for(code) {
    const permissions = permissions_for(code);
    if (permissions.length === 0) {
        return [];
    }
    let granted = false;
    try {
        granted = await chrome.permissions.request({ permissions: permissions });
    } catch (e) {
        granted = false;
    }
    return granted ? [] : permissions;
}

/*
 * missing_permissions(code) -> permissions the code needs that are not granted yet
 */
export async function missing_permissions(code) {
    const missing = [];
    for (const permission of permissions_for(code)) {
        if (!(await chrome.permissions.contains({ permissions: [permission] }))) {
            missing.push(permission);
        }
    }
    return missing;
}
