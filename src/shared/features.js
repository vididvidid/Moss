// Every optional capability of the Moss runtime, in one table.
// The bundler includes a feature only when a script uses it; the exporter derives
// files, permissions and the popup from the same table. Add a feature = add a row
// here + src/shared/runtime/<name>.js (+ src/shared/host/<name>.js if privileged).
//
// Detection: a script (or any module it bundles) uses a feature when its code
// mentions one of the API names. Bracket access in quotes, e.g. api['GM_getValue'],
// is deliberately NOT detected — modules use it for "only if the script has it".

const uses = (names) => new RegExp(`(?<!['"\\w$])(?:${names.join('|')})\\b`);

export const FEATURES = {
  values: {
    label: 'Storage',
    summary: 'GM_getValue / GM_setValue / GM_deleteValue / GM_listValues',
    api: ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues'],
    detect: uses(['GM[_.](?:get|set|delete)Value', 'GM[_.]listValues']),
    host: true,
    permissions: ['storage'],
  },
  style: {
    label: 'Styles & elements',
    summary: 'GM_addStyle / GM_addElement',
    api: ['GM_addStyle', 'GM_addElement'],
    detect: uses(['GM[_.]addStyle', 'GM[_.]addElement']),
  },
  xhr: {
    label: 'Cross-origin requests',
    summary: 'GM_xmlhttpRequest / GM.xmlHttpRequest',
    api: ['GM_xmlhttpRequest'],
    detect: uses(['GM_xmlhttpRequest', 'GM\\.xmlHttpRequest']),
    grants: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
    host: true,
  },
  notify: {
    label: 'Notifications',
    summary: 'GM_notification',
    api: ['GM_notification'],
    detect: uses(['GM[_.]notification']),
    host: true,
    permissions: ['notifications'],
  },
  menu: {
    label: 'Menu commands',
    summary: 'GM_registerMenuCommand (shown in the toolbar popup)',
    api: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'],
    detect: uses(['GM[_.](?:un)?registerMenuCommand']),
    host: true,
    popup: true,
  },
  tabs: {
    label: 'Open tabs',
    summary: 'GM_openInTab',
    api: ['GM_openInTab'],
    detect: uses(['GM[_.]openInTab']),
    host: true,
  },
  clipboard: {
    label: 'Clipboard',
    summary: 'GM_setClipboard',
    api: ['GM_setClipboard'],
    detect: uses(['GM[_.]setClipboard']),
  },
  download: {
    label: 'Downloads',
    summary: 'GM_download',
    api: ['GM_download'],
    detect: uses(['GM[_.]download']),
    grants: ['GM_download'],
    host: true,
    permissions: ['downloads'],
  },
  chrome: {
    label: 'Browser APIs',
    summary: 'moss.chrome.<namespace> — granted with @grant chrome.<namespace>',
    api: [],
    detect: uses(['moss\\.chrome']),
    grantPrefix: 'chrome.',
    host: true,
  },
};

// Always present, whatever the script uses.
export const CORE_API = ['GM', 'GM_info', 'GM_log', 'unsafeWindow', 'moss', 'require'];
export const ALL_API = [...CORE_API, ...Object.values(FEATURES).flatMap((f) => f.api)];

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
export const runtimeTransport = (name) => `src/shared/runtime/transport-${name}.js`;
export const runtimeFeature = (name) => `src/shared/runtime/${name}.js`;
export const HOST_CORE = 'src/shared/host/core.js';
export const hostFeature = (name) => `src/shared/host/${name}.js`;
