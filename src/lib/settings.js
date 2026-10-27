'use strict';
/*
 * Every Moss option lives in a schema; the dashboard renders these tables directly,
 * so adding an option here is all it takes to make it configurable.
 *
 * struct setting {
 *     section: string;    heading it appears under (global settings only)
 *     key: string;        storage key, "group.snake_name"
 *     label: string;
 *     type: 'select' | 'text' | 'password' | 'number' | 'checkbox' | 'list' | 'features';
 *     options: (string | { value, label })[];   for select
 *     default: any;
 *     help: string;       optional hint under the field
 * }
 */
import { CHROME_PERMISSION, FEATURES } from '../shared/features.js';
import { RUN_AT_VALUES, SANDBOXES } from './meta.js';
import { EVERY_OPTIONS } from './updater.js';

// Global settings, stored flat under chrome.storage.local "settings".
export const SETTINGS = [
    { section: 'New scripts', key: 'new.sandbox', label: 'Default @sandbox', type: 'select', options: SANDBOXES, default: 'isolated' },
    { section: 'New scripts', key: 'new.run_at', label: 'Default @run-at', type: 'select', options: RUN_AT_VALUES, default: 'document-idle' },
    { section: 'New scripts', key: 'new.namespace', label: 'Default @namespace', type: 'text', default: 'moss.local' },
    { section: 'New scripts', key: 'new.folder', label: 'Default @folder', type: 'text', default: '' },
    { section: 'New scripts', key: 'new.uses', label: 'Default @use lines', type: 'list', default: ['moss/ui/toast as toast'],
        help: 'One module per line, e.g. "moss/ui as ui".' },

    { section: 'Security', key: 'security.chrome_namespaces', label: 'chrome.* namespaces scripts may request', type: 'list',
        default: Object.keys(CHROME_PERMISSION),
        help: 'A script still needs "@grant chrome.<namespace>". Namespaces beyond these need the matching permission in manifest.json.' },
    { section: 'Security', key: 'security.require_grants', label: 'Require @grant for GM_xmlhttpRequest and GM_download', type: 'checkbox', default: true },
    { section: 'Security', key: 'security.require_connect', label: 'Require @connect for cross-origin requests', type: 'checkbox', default: false },

    { section: 'Runtime', key: 'runtime.strict_default', label: 'Run every script in strict mode', type: 'checkbox', default: false,
        help: 'Recommended for your own scripts — add "// @strict" to the header instead to choose per script. Off by default because many imported scripts are written in sloppy mode.' },
    { section: 'Runtime', key: 'runtime.log_errors', label: 'Log script errors to the console', type: 'checkbox', default: true },
    { section: 'Runtime', key: 'runtime.log_prefix', label: 'Console prefix', type: 'text', default: 'Moss' },
    { section: 'Runtime', key: 'runtime.values_backend', label: 'Where GM values are stored', type: 'select',
        options: ['extension', 'local'], default: 'extension',
        help: '"local" keeps them in the site\'s localStorage (no bridge needed, but the page can read them).' },
    { section: 'Runtime', key: 'runtime.keepalive', label: 'Keep background scripts alive', type: 'checkbox', default: true,
        help: 'Needed for background scripts that listen to browser events.' },

    { section: 'Updates', key: 'update.auto_by_default', label: 'Auto-update newly imported scripts', type: 'checkbox', default: true },
    { section: 'Updates', key: 'update.every', label: 'Default update check', type: 'select', options: EVERY_OPTIONS, default: 360,
        help: 'Each script can pick its own interval in its Options tab.' },
    { section: 'Updates', key: 'update.require_newer_version', label: 'Only auto-update when @version goes up', type: 'checkbox', default: false,
        help: 'Off: any change at the source is pulled in. "↻ Update" always fetches the latest.' },
    { section: 'Updates', key: 'update.overwrite_local', label: 'Auto-update scripts I have edited here', type: 'checkbox', default: false,
        help: 'Off: a script you changed in Moss is left alone and marked "edited locally".' },
    { section: 'Updates', key: 'update.notify', label: 'Notify me when a script is updated', type: 'checkbox', default: true },
    { section: 'GitHub', key: 'github.token', label: 'GitHub token (optional)', type: 'password', default: '',
        help: 'Only needed for private repos, or if you hit GitHub\'s rate limit. A fine-grained token with read-only "Contents" access is enough. Stored in this browser only.' },

    { section: 'Editor', key: 'editor.font_size', label: 'Font size', type: 'number', default: 13 },
    { section: 'Editor', key: 'editor.tab_size', label: 'Tab width', type: 'number', default: 4 },
    { section: 'Editor', key: 'editor.wrap', label: 'Wrap long lines', type: 'checkbox', default: false },
    { section: 'Editor', key: 'editor.theme', label: 'Dashboard theme', type: 'select', options: ['auto', 'light', 'dark'], default: 'auto' },

    { section: 'Export', key: 'export.include_source', label: 'Include the original .user.js', type: 'checkbox', default: true },
    { section: 'Export', key: 'export.include_readme', label: 'Include a README', type: 'checkbox', default: true },
    { section: 'Export', key: 'export.review_manifest', label: 'Let me edit manifest.json before downloading', type: 'checkbox', default: true },
];

// Per-script overrides, stored on the script record as `options`. Empty = use the metadata.
export const SCRIPT_OPTIONS = [
    { key: 'sandbox', label: 'Sandbox', type: 'select', options: [''].concat(SANDBOXES), help: 'Overrides @sandbox.' },
    { key: 'run_at', label: 'Run at', type: 'select', options: [''].concat(RUN_AT_VALUES), help: 'Overrides @run-at.' },
    { key: 'all_frames', label: 'Run in iframes', type: 'select', options: ['', 'yes', 'no'], help: 'Overrides @noframes.' },
    { key: 'strict', label: 'Strict mode', type: 'select', options: ['', 'yes', 'no'],
        help: 'Overrides @strict and the global default. Strict mode turns silent mistakes (like assigning to an undeclared variable) into errors.' },
    { key: 'matches', label: 'Extra @match patterns', type: 'list' },
    { key: 'excludes', label: 'Extra excludes', type: 'list', help: 'Globs (https://site.com/*) or /regex/.' },
    { key: 'delay', label: 'Start delay (ms)', type: 'number', default: 0 },
    { key: 'inject', label: 'Injection', type: 'select', options: ['', 'wrapped', 'raw'],
        help: '"raw" injects your code exactly as written: no GM APIs, no modules.' },
    { key: 'features', label: 'Features', type: 'features', options: Object.keys(FEATURES),
        help: 'auto = included when the code uses it.' },
];

/*
 * settings_defaults() -> { key: default } for every global setting
 */
export function settings_defaults() {
    const out = {};
    for (const setting of SETTINGS) {
        out[setting.key] = structuredClone(setting.default);
    }
    return out;
}

/*
 * resolve_settings(stored) -> defaults overlaid with what the user stored
 */
export function resolve_settings(stored) {
    return Object.assign(settings_defaults(), stored || {});
}

/*
 * host_policy(settings) -> the security policy the API host enforces
 */
export function host_policy(settings) {
    return {
        chrome_namespaces: settings['security.chrome_namespaces'],
        require_grants: settings['security.require_grants'],
        require_connect: settings['security.require_connect'],
    };
}
