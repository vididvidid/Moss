/*
 * Host feature: menu — collects menu commands per connection for the toolbar popup
 * (and Moss's right-click menu, through opts.on_menu_change).
 */
moss_host_features.menu = function (host) {
    'use strict';

    /*
     * changed(conn) — tell the owner that a tab's menu commands changed
     */
    function changed(conn) {
        if (host.opts.on_menu_change) {
            host.opts.on_menu_change(conn);
        }
    }

    host.handlers['menu.register'] = function (conn, script, args) {
        conn.menu.set(args[0], args[1]);
        changed(conn);
        return true;
    };
    host.handlers['menu.unregister'] = function (conn, script, args) {
        conn.menu.delete(args[0]);
        changed(conn);
        return true;
    };

    /*
     * list_menus(tab_id) -> [{ conn, id, caption, script_id, background }] for a tab,
     * plus those of background scripts (tab_id null)
     */
    host.list_menus = function (tab_id) {
        const out = [];
        for (const conn of host.conns.values()) {
            const background = conn.tab_id === null || conn.tab_id === undefined;
            if (conn.tab_id !== tab_id && !background) {
                continue;
            }
            for (const [id, caption] of conn.menu) {
                out.push({ conn: conn.key, id: id, caption: caption, script_id: conn.script_id, background: background });
            }
        }
        return out;
    };

    /*
     * run_menu(conn_key, id) -> true if the command was sent to its script
     */
    host.run_menu = function (conn_key, id) {
        const conn = host.conns.get(conn_key);
        if (conn === undefined || !conn.menu.has(id)) {
            return false;
        }
        conn.send({ push: 'menu', id: id });
        return true;
    };
};
