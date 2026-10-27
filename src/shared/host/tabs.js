/*
 * Host feature: tabs — GM_openInTab. A script may only close tabs it opened, and it is
 * told when one of them closes (push 'tab_closed').
 */
moss_host_features.tabs = function (host) {
    'use strict';

    if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener(function (tab_id) {
            for (const conn of host.conns.values()) {
                if (conn.opened !== undefined && conn.opened.has(tab_id)) {
                    conn.opened.delete(tab_id);
                    conn.send({ push: 'tab_closed', id: tab_id });
                }
            }
        });
    }

    host.handlers['tabs.open'] = async function (conn, script, args) {
        const opts = args[1] || {};
        const create = { url: args[0], active: opts.active !== false };
        const has_opener = conn.tab_id !== null && conn.tab_id !== undefined;
        if (has_opener) {
            create.openerTabId = conn.tab_id;
            if (opts.insert) {
                // Right next to the tab that opened it, like a link opened from it.
                try {
                    const opener = await chrome.tabs.get(conn.tab_id);
                    create.index = opener.index + 1;
                    create.windowId = opener.windowId;
                } catch (e) {
                    // opener gone: let Chrome choose
                }
            }
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
        await chrome.tabs.remove(args[0]);
        return true;
    };
};
