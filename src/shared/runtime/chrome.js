/*
 * Feature: chrome — grant-checked browser APIs:
 *     await moss.chrome.history.search({ text: '' })
 *     moss.chrome.history.onVisited.addListener(fn)
 * Each namespace needs "// @grant chrome.<namespace>". In an exported background
 * script this is simply the real `chrome` object.
 */
(function () {
    'use strict';
    if (rt.ctx.native_chrome) {
        rt.moss.chrome = globalThis.chrome;
        return;
    }

    let seq = 0;
    const subs = {};

    rt.push.event = function (msg) {
        const sub = subs[msg.id];
        if (sub === undefined) {
            return;
        }
        Promise.resolve().then(function () {
            return sub.fn.apply(null, msg.args);
        }).catch(rt.report);
    };
    rt.resync.push(function () {
        for (const id of Object.keys(subs)) {
            rt.call('chrome.listen', [subs[id].path, id]).catch(rt.report);
        }
    });

    /*
     * event(path) -> an object with the chrome event methods for "ns.onSomething"
     */
    function event(path) {
        /*
         * find(fn) -> ids of the subscriptions of fn on this event
         */
        function find(fn) {
            const ids = [];
            for (const id of Object.keys(subs)) {
                if (subs[id].path === path && subs[id].fn === fn) {
                    ids.push(id);
                }
            }
            return ids;
        }
        return {
            addListener: function (fn) {
                seq++;
                const id = 'e' + seq;
                subs[id] = { path: path, fn: fn };
                rt.call('chrome.listen', [path, id]).catch(rt.report);
            },
            removeListener: function (fn) {
                for (const id of find(fn)) {
                    delete subs[id];
                    rt.call('chrome.unlisten', [id]).catch(rt.report);
                }
            },
            hasListener: function (fn) {
                return find(fn).length > 0;
            },
        };
    }

    /*
     * node(path) -> a proxy standing for chrome.<path>: reading goes deeper, calling
     * asks the extension to run it
     */
    function node(path) {
        return new Proxy(function () {}, {
            get: function (target, key) {
                if (typeof key !== 'string' || key === 'then') {
                    return undefined;
                }
                const next = path.concat(key);
                return /^on[A-Z]/.test(key) ? event(next.join('.')) : node(next);
            },
            apply: function (target, self, args) {
                return rt.call('chrome', [path.join('.'), args]);
            },
        });
    }

    rt.moss.chrome = node([]);
})();
