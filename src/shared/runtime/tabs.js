/*
 * Feature: tabs — GM_openInTab. Returns a Tampermonkey-style handle:
 *     { closed, close(), onclose }  — closed turns true when the tab goes away,
 *                                     however it was closed.
 * Options: true (= open in background) or { active, insert, setParent }.
 * Falls back to window.open without a bridge.
 */
(function () {
    'use strict';
    const handles = {}; // tab id -> handle

    rt.push.tab_closed = function (msg) {
        const handle = handles[msg.id];
        if (handle === undefined) {
            return;
        }
        delete handles[msg.id];
        handle.closed = true;
        if (typeof handle.onclose === 'function') {
            try {
                handle.onclose();
            } catch (e) {
                rt.report(e);
            }
        }
    };

    /*
     * open_tab(url, opts) -> handle
     */
    function open_tab(url, opts) {
        let options = opts || {};
        if (typeof opts === 'boolean') {
            options = { active: !opts };
        }
        const handle = { closed: false, onclose: null, close: function () {} };
        if (rt.transport === null) {
            const win = window.open(url, '_blank');
            handle.close = function () {
                handle.closed = true;
                if (win) {
                    win.close();
                }
            };
            return handle;
        }
        const request = { active: options.active !== false, insert: options.insert !== false, set_parent: !!options.setParent };
        const tab = rt.call('tabs.open', [String(url), request]).then(function (id) {
            handles[id] = handle;
            return id;
        }, function (e) {
            rt.report(e);
            return null;
        });
        handle.close = function () {
            tab.then(function (id) {
                if (id !== null && !handle.closed) {
                    rt.call('tabs.close', [id]).catch(rt.report);
                }
            });
        };
        return handle;
    }

    rt.api.GM_openInTab = open_tab;
    rt.gm.openInTab = function (url, opts) {
        return Promise.resolve(open_tab(url, opts));
    };
})();
