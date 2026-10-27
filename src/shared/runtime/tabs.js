/*
 * Feature: tabs — GM_openInTab. Falls back to window.open without a bridge.
 */
(function () {
    'use strict';

    /*
     * open_tab(url, opts) -> { closed, close() }
     *   opts: true (= open in background) or { active, insert }
     */
    function open_tab(url, opts) {
        let options = opts || {};
        if (typeof opts === 'boolean') {
            options = { active: !opts };
        }
        const handle = { closed: false, close: function () {} };
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
        const tab = rt.call('tabs.open', [String(url), { active: options.active !== false, insert: options.insert !== false }])
            .catch(function (e) {
                rt.report(e);
                return null;
            });
        handle.close = function () {
            handle.closed = true;
            tab.then(function (id) {
                if (id !== null) {
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
