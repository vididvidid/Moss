'use strict';
/*
 * moss/ui/settings — a settings dialog from a schema, saved with GM values.
 *     const prefs = settings({
 *         title: 'My script', key: 'settings',
 *         fields: [{ key: 'wpm', label: 'Words per minute', type: 'number', default: 230 }],
 *         menu: true,   // add "⚙ My script settings" to the popup (if the script has menu commands)
 *         fab: false,   // or a floating ⚙ button — handy in page mode
 *     });
 *     prefs.get('wpm'); prefs.values; prefs.set('wpm', 300); prefs.open(); prefs.on_change(fn);
 */
const form = require('moss/ui/form');
const modal = require('moss/ui/modal');

/*
 * blank_value(def) -> the value a field has when it has no default
 */
function blank_value(def) {
    if (def.type === 'checkbox') {
        return false;
    }
    if (def.type === 'list') {
        return [];
    }
    return '';
}

/*
 * settings(opts) -> { get, values, set, open, on_change }
 */
function settings(opts) {
    const key = opts.key || 'settings';
    const fields = opts.fields || [];
    const defaults = {};
    for (const def of fields) {
        defaults[def.key] = def.default !== undefined ? def.default : blank_value(def);
    }
    const listeners = [];

    /*
     * values() -> defaults overlaid with what is stored
     */
    function values() {
        return Object.assign({}, defaults, api.GM_getValue(key, {}));
    }

    /*
     * store(next) — save and tell the listeners
     */
    function store(next) {
        api.GM_setValue(key, next);
        for (const fn of listeners) {
            fn(next);
        }
    }

    /*
     * open() -> Promise of the values after the dialog closes
     */
    async function open() {
        const f = form.form(fields, values());
        const choice = await modal.modal({
            title: opts.title || 'Settings',
            body: f.el,
            actions: [
                { label: 'Reset', value: 'reset', variant: 'ghost' },
                { label: 'Cancel', value: null },
                { label: 'Save', value: 'save', variant: 'primary' },
            ],
        });
        if (choice === 'save') {
            store(Object.assign(values(), f.values()));
        }
        if (choice === 'reset') {
            store({});
        }
        return values();
    }

    // Optional access: only uses menu commands if the script already includes them.
    const register = api['GM_registerMenuCommand'];
    if (opts.menu !== false && register) {
        register(typeof opts.menu === 'string' ? opts.menu : '⚙ ' + (opts.title || 'Settings'), open);
    }
    if (opts.fab) {
        const position = opts.fab === true ? 'bottom-left' : opts.fab;
        require('moss/ui/fab')({ icon: '⚙', title: opts.title || 'Settings', on_click: open, position: position });
    }

    return {
        get: function (name) {
            return values()[name];
        },
        get values() {
            return values();
        },
        set: function (name, value) {
            const next = api.GM_getValue(key, {});
            next[name] = value;
            store(next);
        },
        open: open,
        on_change: function (fn) {
            listeners.push(fn);
        },
    };
}

module.exports = settings;
