/*
 * Host feature: tab — GM_getTab / GM_saveTab / GM_getTabs. Kept in
 * chrome.storage.session ("tab_data") so it survives the service worker going to
 * sleep, and dropped when the tab closes.
 *
 * tab_data: { [script id]: { [tab id or "bg"]: object } }
 */
moss_host_features.tab = function (host) {
    'use strict';
    const KEY = 'tab_data';
    let queue = Promise.resolve();

    /*
     * edit(change) -> Promise of change(data)'s result; writes are serialised
     */
    function edit(change) {
        const next = queue.then(async function () {
            const got = await chrome.storage.session.get(KEY);
            const data = got[KEY] || {};
            const result = change(data);
            const patch = {};
            patch[KEY] = data;
            await chrome.storage.session.set(patch);
            return result;
        });
        queue = next.catch(function () {});
        return next;
    }

    /*
     * read_all() -> the whole tab_data object, after any pending save (so GM_getTab right
     * after GM_saveTab sees the saved object)
     */
    function read_all() {
        const next = queue.then(async function () {
            const got = await chrome.storage.session.get(KEY);
            return got[KEY] || {};
        });
        queue = next.catch(function () {});
        return next;
    }

    /*
     * tab_key(conn) -> where the connection's object is kept
     */
    function tab_key(conn) {
        return conn.tab_id === null || conn.tab_id === undefined ? 'bg' : String(conn.tab_id);
    }

    if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener(function (tab_id) {
            edit(function (data) {
                for (const script_id of Object.keys(data)) {
                    delete data[script_id][String(tab_id)];
                }
            });
        });
    }

    host.handlers['tab.get'] = async function (conn, script) {
        const data = await read_all();
        const mine = data[script.id] || {};
        return mine[tab_key(conn)] || {};
    };

    host.handlers['tab.save'] = function (conn, script, args) {
        return edit(function (data) {
            if (data[script.id] === undefined) {
                data[script.id] = {};
            }
            data[script.id][tab_key(conn)] = args[0] || {};
            return true;
        });
    };

    host.handlers['tab.list'] = async function (conn, script) {
        const data = await read_all();
        return data[script.id] || {};
    };
};
