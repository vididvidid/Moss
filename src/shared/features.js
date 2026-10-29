'use strict';
/*
 * Every optional capability of the Moss runtime, in one table.
 * The bundler includes a feature only when a script uses it; the exporter derives
 * files, permissions and the popup from the same table. To add a feature: add a
 * row here + src/shared/runtime/<name>.js (+ src/shared/host/<name>.js if privileged).
 *
 * Detection: a script (or a module it bundles) uses a feature when its code
 * mentions one of the API names. Bracket access in quotes, e.g. api['GM_getValue'],
 * is deliberately NOT detected — modules use it for "only if the script has it".
 *
 * struct feature {
 *     label: string;           shown in the dashboard
 *     summary: string;         one-line description
 *     api: string[];           GM_* names this feature provides
 *     detect: RegExp;          finds a use of the feature in code
 *     grants: string[];        @grant values that also switch it on (optional)
 *     grant_prefix: string;    @grant prefix that switches it on (optional)
 *     host: boolean;           needs the privileged side (src/shared/host/<name>.js)
 *     permissions: string[];   manifest permissions it needs when bundled with a host
 *     popup: boolean;          needs the toolbar popup in an exported extension
 * }
 */

/*
 * uses_any(names) -> RegExp matching any of names as a whole word, not inside quotes
 */
function uses_any(names) {
    return new RegExp(`(?<!['"\\w$])(?:${names.join('|')})\\b`);
}

export const FEATURES = {
    values: {
        label: 'Storage',
        summary: 'GM_getValue / GM_setValue / GM_deleteValue / GM_listValues / GM_getValues / GM_addValueChangeListener',
        api: ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_getValues', 'GM_setValues', 'GM_deleteValues',
            'GM_addValueChangeListener', 'GM_removeValueChangeListener'],
        detect: uses_any(['GM[_.](?:get|set|delete)Values?', 'GM[_.]listValues', 'GM[_.](?:add|remove)ValueChangeListener']),
        host: true,
        permissions: ['storage'],
    },
    style: {
        label: 'Styles & elements',
        summary: 'GM_addStyle / GM_addElement',
        api: ['GM_addStyle', 'GM_addElement'],
        detect: uses_any(['GM[_.]addStyle', 'GM[_.]addElement']),
    },
    xhr: {
        label: 'Cross-origin requests',
        summary: 'GM_xmlhttpRequest / GM.xmlHttpRequest',
        api: ['GM_xmlhttpRequest'],
        detect: uses_any(['GM_xmlhttpRequest', 'GM\\.xmlHttpRequest']),
        grants: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
        host: true,
    },
    notify: {
        label: 'Notifications',
        summary: 'GM_notification',
        api: ['GM_notification'],
        detect: uses_any(['GM[_.]notification']),
        host: true,
        permissions: ['notifications'],
    },
    menu: {
        label: 'Menu commands',
        summary: 'GM_registerMenuCommand (shown in the toolbar popup)',
        api: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'],
        detect: uses_any(['GM[_.](?:un)?registerMenuCommand']),
        host: true,
        popup: true,
    },
    tabs: {
        label: 'Open tabs',
        summary: 'GM_openInTab',
        api: ['GM_openInTab'],
        detect: uses_any(['GM[_.]openInTab']),
        host: true,
    },
    clipboard: {
        label: 'Clipboard',
        summary: 'GM_setClipboard',
        api: ['GM_setClipboard'],
        detect: uses_any(['GM[_.]setClipboard']),
    },
    download: {
        label: 'Downloads',
        summary: 'GM_download',
        api: ['GM_download'],
        detect: uses_any(['GM[_.]download']),
        grants: ['GM_download'],
        host: true,
        permissions: ['downloads'],
    },
    resource: {
        label: 'Resources',
        summary: 'GM_getResourceText / GM_getResourceURL for @resource files (fetched once, bundled)',
        api: ['GM_getResourceText', 'GM_getResourceURL'],
        detect: uses_any(['GM[_.]getResource(?:Text|URL|Url)']),
    },
    urlchange: {
        label: 'URL changes',
        summary: 'window.onurlchange / "urlchange" events when a single-page app changes the address',
        api: [],
        detect: /\bonurlchange\b|(['"])urlchange\1/,
        grants: ['window.onurlchange'],
    },
    window: {
        label: 'Close / focus tab',
        summary: 'window.close() and window.focus() on the script\'s tab (@grant window.close / window.focus)',
        api: [],
        detect: /(?!)/,
        grants: ['window.close', 'window.focus'],
        host: true,
    },
    tab: {
        label: 'Tab storage',
        summary: 'GM_getTab / GM_saveTab / GM_getTabs — an object per tab that lives as long as the tab',
        api: ['GM_getTab', 'GM_saveTab', 'GM_getTabs'],
        detect: uses_any(['GM[_.](?:get|save)Tabs?']),
        host: true,
        permissions: ['storage'],
    },
    cookie: {
        label: 'Cookies',
        summary: 'GM_cookie.list / set / delete (@grant GM_cookie)',
        api: ['GM_cookie'],
        detect: uses_any(['GM[_.]cookie']),
        grants: ['GM_cookie', 'GM.cookie'],
        host: true,
        permissions: ['cookies'],
    },
    audio: {
        label: 'Tab audio',
        summary: 'GM_audio.setMute / getState / addStateChangeListener — mute the script\'s tab and follow its sound',
        api: ['GM_audio'],
        detect: uses_any(['GM[_.]audio']),
        grants: ['GM_audio', 'GM.audio'],
        host: true,
    },
    chrome: {
        label: 'Browser APIs',
        summary: 'moss.chrome.<namespace> — granted with @grant chrome.<namespace>',
        api: [],
        detect: uses_any(['moss\\.chrome']),
        grant_prefix: 'chrome.',
        host: true,
    },
};

// Always present, whatever the script uses.
export const CORE_API = ['GM', 'GM_info', 'GM_log', 'unsafeWindow', 'moss', 'require'];

/*
 * all_api() -> every API name a script can receive: the core ones, then each feature's
 */
function all_api() {
    const names = CORE_API.slice();
    for (const name of Object.keys(FEATURES)) {
        for (const api_name of FEATURES[name].api) {
            names.push(api_name);
        }
    }
    return names;
}
export const ALL_API = all_api();

// chrome.<namespace> → the manifest permission it needs (null = none needed).
export const CHROME_PERMISSION = {
    history: 'history',
    browsingData: 'browsingData',
    bookmarks: 'bookmarks',
    downloads: 'downloads',
    cookies: 'cookies',
    topSites: 'topSites',
    sessions: 'sessions',
    tabs: 'tabs',
    windows: null,
    notifications: 'notifications',
};

// Built-in modules: name → file inside the extension.
export const BUILTIN_MODULES = {
    'moss/ui': 'src/modules/moss/ui/index.js',
    'moss/ui/core': 'src/modules/moss/ui/core.js',
    'moss/ui/button': 'src/modules/moss/ui/button.js',
    'moss/ui/toast': 'src/modules/moss/ui/toast.js',
    'moss/ui/panel': 'src/modules/moss/ui/panel.js',
    'moss/ui/modal': 'src/modules/moss/ui/modal.js',
    'moss/ui/fab': 'src/modules/moss/ui/fab.js',
    'moss/ui/form': 'src/modules/moss/ui/form.js',
    'moss/ui/settings': 'src/modules/moss/ui/settings.js',
    'moss/dom': 'src/modules/moss/dom/index.js',
    'moss/dom/query': 'src/modules/moss/dom/query.js',
    'moss/dom/wait': 'src/modules/moss/dom/wait.js',
    'moss/dom/url': 'src/modules/moss/dom/url.js',
    'moss/dom/util': 'src/modules/moss/dom/util.js',
};

export const RUNTIME_CORE = 'src/shared/runtime/core.js';
export const RUNTIME_RELAY = 'src/shared/runtime/relay.js';
export const HOST_CORE = 'src/shared/host/core.js';

/*
 * runtime_transport(name) -> path of the runtime file for one transport
 */
export function runtime_transport(name) {
    return `src/shared/runtime/transport-${name}.js`;
}

/*
 * runtime_feature(name) -> path of the runtime file for one feature
 */
export function runtime_feature(name) {
    return `src/shared/runtime/${name}.js`;
}

/*
 * host_feature(name) -> path of the host file for one feature
 */
export function host_feature(name) {
    return `src/shared/host/${name}.js`;
}
