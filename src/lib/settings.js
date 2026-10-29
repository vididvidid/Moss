'use strict';
/*
 * Every Moss option lives in a schema; the dashboard renders these tables directly,
 * so adding an option here is all it takes to make it configurable.
 *
 * struct setting {
 *     section: string;    heading it appears under (global settings only)
 *     key: string;        storage key, "group.snake_name"
 *     label: string;
 *     type: 'select' | 'text' | 'password' | 'number' | 'checkbox' | 'list' | 'textarea' | 'features';
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
    { section: 'General', key: 'general.trash', label: 'Move deleted scripts to the trash', type: 'checkbox', default: true,
        help: 'Restore them (with their values) from the Trash section below. Off: deleting is final.' },
    { section: 'General', key: 'general.on_switch', label: 'When Moss is switched on or off', type: 'select',
        options: [
            { value: 'all', label: 'Reload every page a script runs on' },
            { value: 'active', label: 'Reload only the current page' },
            { value: 'nothing', label: 'Do nothing' },
        ],
        default: 'all',
        help: 'A script that already ran keeps running until its page reloads, so reloading cleans it up (or starts it).' },
    { section: 'General', key: 'install.detect_urls', label: 'Offer to install .user.js / .moss links I open', type: 'checkbox', default: true,
        help: 'Opening a link to a userscript (e.g. on Greasy Fork or GitHub) opens Moss\'s install dialog.' },

    { section: 'New scripts', key: 'new.format', label: 'Format of new scripts', type: 'select',
        options: [{ value: 'moss', label: '.moss (Moss header, strict by default)' }, { value: 'userscript', label: 'Userscript (// ==UserScript==)' }],
        default: 'moss',
        help: 'Both formats install and run the same way; Tampermonkey and Violentmonkey scripts keep their header. Convert one with the ⇄ button in the editor.' },
    { section: 'New scripts', key: 'new.sandbox', label: 'Default @sandbox', type: 'select', options: SANDBOXES, default: 'isolated' },
    { section: 'New scripts', key: 'new.run_at', label: 'Default @run-at', type: 'select', options: RUN_AT_VALUES, default: 'document-idle' },
    { section: 'New scripts', key: 'new.namespace', label: 'Default @namespace', type: 'text', default: 'moss.local' },
    { section: 'New scripts', key: 'new.folder', label: 'Default @folder', type: 'text', default: '' },
    { section: 'New scripts', key: 'new.uses', label: 'Default @use lines', type: 'list', default: ['moss/ui/toast as toast'],
        help: 'One module per line, e.g. "moss/ui as ui".' },
    { section: 'New scripts', key: 'new.template', label: 'New script template', type: 'textarea', default: '',
        help: 'Empty: Moss builds one from the defaults above. Placeholders: <$NAME$> <$URL$> <$MATCH$> <$DATE$> <$NAMESPACE$>.' },

    { section: 'Security', key: 'security.chrome_namespaces', label: 'chrome.* namespaces scripts may request', type: 'list',
        default: Object.keys(CHROME_PERMISSION),
        help: 'A script still needs "@grant chrome.<namespace>". Namespaces beyond these need the matching permission in manifest.json.' },
    { section: 'Security', key: 'security.require_grants', label: 'Require @grant for GM_xmlhttpRequest and GM_download', type: 'checkbox', default: true },
    { section: 'Security', key: 'security.require_connect', label: 'Require @connect for cross-origin requests', type: 'checkbox', default: false },
    { section: 'Security', key: 'security.blocked_pages', label: 'Never run scripts on these pages', type: 'list', default: [],
        help: 'One per line: match patterns (https://*.bank.com/*), globs (*paypal.com/*) or /regex/. Applies to every script.' },
    { section: 'Security', key: 'security.sri', label: 'Subresource integrity (#sha256=… on @require / @resource)', type: 'select',
        options: [{ value: 'validate', label: 'Check hashes' }, { value: 'ignore', label: 'Ignore hashes' }], default: 'validate' },
    { section: 'Security', key: 'security.cookies', label: 'GM_cookie may see', type: 'select',
        options: [{ value: 'no_httponly', label: 'All but HttpOnly cookies' }, { value: 'all', label: 'All cookies' }, { value: 'none', label: 'No cookies' }],
        default: 'no_httponly' },

    { section: 'Runtime', key: 'runtime.strict_default', label: 'Run every script in strict mode', type: 'checkbox', default: false,
        help: 'Recommended for your own scripts — add "// @strict" to the header instead to choose per script. Off by default because many imported scripts are written in sloppy mode.' },
    { section: 'Runtime', key: 'runtime.log_errors', label: 'Log script errors to the console', type: 'checkbox', default: true },
    { section: 'Runtime', key: 'runtime.log_prefix', label: 'Console prefix', type: 'text', default: 'Moss' },
    { section: 'Runtime', key: 'runtime.values_backend', label: 'Where GM values are stored', type: 'select',
        options: ['extension', 'local'], default: 'extension',
        help: '"local" keeps them in the site\'s localStorage (no bridge needed, but the page can read them).' },
    { section: 'Runtime', key: 'runtime.keepalive', label: 'Keep background scripts alive', type: 'checkbox', default: true,
        help: 'Needed for background scripts that listen to browser events.' },

    { section: 'Popup', key: 'popup.hide_disabled', label: 'Hide disabled scripts', type: 'checkbox', default: false },
    { section: 'Popup', key: 'popup.badge', label: 'Toolbar icon badge', type: 'select',
        options: [
            { value: 'running', label: 'Number of scripts running on the tab' },
            { value: 'errors', label: 'Only "!" when a script fails' },
            { value: 'none', label: 'Nothing' },
        ],
        default: 'running',
        help: 'A tab where a script failed shows its count in red.' },
    { section: 'Popup', key: 'menu.context_menu', label: 'Show menu commands in the right-click menu', type: 'checkbox', default: true,
        help: 'Scripts with "@run-at context-menu" are always listed there.' },
    { section: 'Popup', key: 'menu.open_moss', label: 'Show "Open Moss" in the right-click menu', type: 'checkbox', default: true },
    { section: 'Popup', key: 'popup.on_toggle', label: 'When I switch a script on or off in the popup', type: 'select',
        options: [
            { value: 'reload', label: 'Reload the page' },
            { value: 'button', label: 'Show a "Reload page" button' },
            { value: 'nothing', label: 'Do nothing' },
        ],
        default: 'reload',
        help: 'Page scripts only take effect on the next page load. Background scripts restart by themselves, so switching one never reloads the page. For the global On/Off switch see General → "When Moss is switched on or off".' },

    { section: 'Updates', key: 'update.auto_by_default', label: 'Auto-update newly imported scripts', type: 'checkbox', default: true },
    { section: 'Updates', key: 'update.every', label: 'Default update check', type: 'select', options: EVERY_OPTIONS, default: 360,
        help: 'Each script can pick its own interval in its Options tab.' },
    { section: 'Updates', key: 'update.require_newer_version', label: 'Only auto-update when @version goes up', type: 'checkbox', default: false,
        help: 'Off: any change at the source is pulled in. "↻ Update" always fetches the latest.' },
    { section: 'Updates', key: 'update.overwrite_local', label: 'Auto-update scripts I have edited here', type: 'checkbox', default: false,
        help: 'Off: a script you changed in Moss is left alone and marked "edited locally".' },
    { section: 'Updates', key: 'update.header_urls', label: 'Update scripts from their own @updateURL / @downloadURL', type: 'checkbox', default: true,
        help: 'For scripts not imported from a link (pasted, restored, made here). Only a higher @version is installed.' },
    { section: 'Updates', key: 'update.disabled_scripts', label: 'Update disabled scripts too', type: 'checkbox', default: true },
    { section: 'Updates', key: 'update.notify', label: 'Notify me when a script is updated', type: 'checkbox', default: true },
    { section: 'GitHub', key: 'github.token', label: 'GitHub token (optional)', type: 'password', default: '',
        help: 'Only needed for private repos, or if you hit GitHub\'s rate limit. A fine-grained token with read-only "Contents" access is enough. Stored in this browser only.' },

    { section: 'Editor', key: 'editor.font_size', label: 'Font size', type: 'number', default: 13 },
    { section: 'Editor', key: 'editor.tab_size', label: 'Tab width', type: 'number', default: 4 },
    { section: 'Editor', key: 'editor.wrap', label: 'Wrap long lines', type: 'checkbox', default: false },
    { section: 'Editor', key: 'editor.theme', label: 'Dashboard theme', type: 'select', options: ['auto', 'light', 'dark'], default: 'auto' },
    { section: 'Editor', key: 'editor.highlight', label: 'Colour the code (syntax highlighting)', type: 'checkbox', default: true },
    { section: 'Editor', key: 'editor.format_on_save', label: 'Auto-format when saving', type: 'checkbox', default: false,
        help: 'The Format button and Alt+Shift+F format at any time.' },
    { section: 'Editor', key: 'editor.format_spacing', label: 'Auto-format also tidies spaces inside lines', type: 'checkbox', default: true,
        help: 'Off: it only re-indents. It never joins or splits lines, and leaves strings, regexes and comments alone.' },
    { section: 'Editor', key: 'editor.format_blank_lines', label: 'Blank lines auto-format keeps in a row', type: 'number', default: 1 },
    { section: 'Editor', key: 'editor.indent_with', label: 'Indent with', type: 'select', options: ['spaces', 'tabs'], default: 'spaces' },
    { section: 'Editor', key: 'editor.trim_trailing', label: 'Trim trailing whitespace when saving', type: 'checkbox', default: false },
    { section: 'Editor', key: 'editor.save_on_blur', label: 'Save when the editor loses focus', type: 'checkbox', default: false },
    { section: 'Editor', key: 'editor.keys', label: 'Custom shortcuts', type: 'list', default: [],
        help: 'One per line, "Keys = command", e.g. "Ctrl-Shift-K = delete_line". Use "Keys = none" to free a shortcut. The commands and defaults are listed in Docs → Editor shortcuts.' },

    { section: 'Export', key: 'export.include_source', label: 'Include the original script file', type: 'checkbox', default: true },
    { section: 'Export', key: 'export.include_readme', label: 'Include a README', type: 'checkbox', default: true },
    { section: 'Backup', key: 'backup.include_externals', label: 'Include downloaded @require / @resource files in backups', type: 'checkbox', default: false,
        help: 'Makes the backup bigger, but restores work offline.' },
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
        cookies: settings['security.cookies'],
    };
}
