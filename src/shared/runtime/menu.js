/*
 * Feature: menu — GM_registerMenuCommand; commands show up in the toolbar popup.
 */
(function () {
    'use strict';
    let seq = 0;
    const items = {};

    rt.push.menu = function (msg) {
        const item = items[msg.id];
        if (item !== undefined) {
            Promise.resolve().then(item.fn).catch(rt.report);
        }
    };
    rt.resync.push(function () {
        for (const id of Object.keys(items)) {
            rt.call('menu.register', [id, items[id].caption]).catch(rt.report);
        }
    });

    /*
     * register(caption, fn, opts) -> the command's id
     */
    function register(caption, fn, opts) {
        let id = null;
        if (opts && typeof opts === 'object' && opts.id) {
            id = opts.id;
        } else {
            seq++;
            id = 'm' + seq;
        }
        items[id] = { caption: String(caption), fn: fn };
        rt.call('menu.register', [id, items[id].caption]).catch(rt.report);
        return id;
    }

    /*
     * unregister(id) — remove a command
     */
    function unregister(id) {
        if (items[id] === undefined) {
            return;
        }
        delete items[id];
        rt.call('menu.unregister', [id]).catch(rt.report);
    }

    rt.api.GM_registerMenuCommand = register;
    rt.gm.registerMenuCommand = register;
    rt.api.GM_unregisterMenuCommand = unregister;
    rt.gm.unregisterMenuCommand = unregister;
})();
