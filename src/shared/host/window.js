/*
 * Host feature: window — close or focus the tab a script runs in, when it has
 * "@grant window.close" / "@grant window.focus".
 */
moss_host_features.window = function (host) {
    'use strict';

    /*
     * own_tab(conn) -> the script's tab id, or throws for background scripts
     */
    function own_tab(conn) {
        if (conn.tab_id === null || conn.tab_id === undefined) {
            throw new Error('Moss: this script does not run in a tab');
        }
        return conn.tab_id;
    }

    host.handlers['window.close'] = async function (conn, script) {
        host.require_grant(script, ['window.close'], 'window.close()');
        await chrome.tabs.remove(own_tab(conn));
        return true;
    };

    host.handlers['window.focus'] = async function (conn, script) {
        host.require_grant(script, ['window.focus'], 'window.focus()');
        const tab = await chrome.tabs.update(own_tab(conn), { active: true });
        if (chrome.windows && tab) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
        return true;
    };
};
