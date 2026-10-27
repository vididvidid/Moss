/*
 * Host feature: tabs — GM_openInTab; a script may only close tabs it opened.
 */
moss_host_features.tabs = function (host) {
    'use strict';

    host.handlers['tabs.open'] = async function (conn, script, args) {
        const opts = args[1] || {};
        const create = { url: args[0], active: opts.active !== false };
        if (conn.tab_id !== null && conn.tab_id !== undefined) {
            create.openerTabId = conn.tab_id;
        }
        const tab = await chrome.tabs.create(create);
        if (conn.opened === undefined) {
            conn.opened = new Set();
        }
        conn.opened.add(tab.id);
        return tab.id;
    };
    host.handlers['tabs.close'] = async function (conn, script, args) {
        if (conn.opened === undefined || !conn.opened.has(args[0])) {
            throw new Error('Moss: a script can only close tabs it opened');
        }
        conn.opened.delete(args[0]);
        await chrome.tabs.remove(args[0]);
        return true;
    };
};
