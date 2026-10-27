/*
 * Feature: cookie — Tampermonkey's GM_cookie (needs "@grant GM_cookie").
 *     GM_cookie.list({ url, domain, name, path }, fn)   fn(cookies, error)
 *     GM_cookie.set({ url, name, value, domain, path, secure, httpOnly, expirationDate }, fn)   fn(error)
 *     GM_cookie.delete({ url, name }, fn)               fn(error)
 * url defaults to the page the script runs on. GM.cookie.* return promises.
 * Settings → Security decides whether HttpOnly cookies are visible.
 */
(function () {
    'use strict';

    /*
     * action(method) -> GM_cookie.<method>(details, fn) in callback style
     */
    function action(method) {
        return function (details, fn) {
            rt.call('cookie.' + method, [details || {}]).then(function (value) {
                if (typeof fn !== 'function') {
                    return;
                }
                if (method === 'list') {
                    fn(value, undefined);
                } else {
                    fn(undefined);
                }
            }, function (e) {
                if (typeof fn !== 'function') {
                    rt.report(e);
                    return;
                }
                if (method === 'list') {
                    fn([], String(e.message || e));
                } else {
                    fn(String(e.message || e));
                }
            });
        };
    }

    // Old style: GM_cookie('list', details, fn).
    const cookie = function (method, details, fn) {
        action(method)(details, fn);
    };
    cookie.list = action('list');
    cookie.set = action('set');
    cookie.delete = action('delete');
    rt.api.GM_cookie = cookie;

    rt.gm.cookie = {
        list: function (details) {
            return rt.call('cookie.list', [details || {}]);
        },
        set: function (details) {
            return rt.call('cookie.set', [details || {}]);
        },
        delete: function (details) {
            return rt.call('cookie.delete', [details || {}]);
        },
    };
})();
