/*
 * Moss API host core — the privileged side of the runtime. Feature files register
 * handlers with moss_host_features.<name> = function (host) {...}. Moss's service
 * worker loads every feature; an exported extension gets this core plus only the
 * features its script uses.
 *
 * struct host_opts {
 *     get_script(conn) -> Promise<struct script_info | null>;
 *     policy: { chrome_namespaces: string[]|null, require_grants: boolean, require_connect: boolean };
 *     icon: string;                          default notification icon URL
 *     on_error(script, message, conn);      optional, called for script errors
 * }
 * struct script_info { id, name: string; grants, connect: string[]; }
 * struct conn {
 *     key: string;              "c1", "c2", …
 *     script_id: string;
 *     token: string;            the secret the script presented (Moss only)
 *     trusted: boolean;         from Moss's own runner, no token needed
 *     tab_id: number | null;    null for background scripts
 *     url: string;              page the script runs on
 *     send(msg);                push a message to the script
 *     menu: Map<id, caption>;   its menu commands
 *     subs: Map<id, unsubscribe function>;   its chrome.* event listeners
 * }
 */
(function () {
    'use strict';
    if (globalThis.moss_host_features === undefined) {
        globalThis.moss_host_features = {};
    }

    /*
     * moss_host(opts) -> the host: attach connections, then handle(conn, method, args)
     */
    function moss_host(opts) {
        const host = {
            opts: opts,
            policy: opts.policy || {},
            handlers: {},
            conns: new Map(),
            seq: 0,
        };

        /*
         * attach(info) -> a new struct conn
         */
        function attach(info) {
            host.seq++;
            const conn = Object.assign({ key: 'c' + host.seq, menu: new Map(), subs: new Map() }, info);
            host.conns.set(conn.key, conn);
            return conn;
        }

        /*
         * detach(conn) — drop a connection and its event listeners
         */
        function detach(conn) {
            for (const unsubscribe of conn.subs.values()) {
                try {
                    unsubscribe();
                } catch (e) {
                    // already gone
                }
            }
            host.conns.delete(conn.key);
        }

        /*
         * attach_port(port, info) -> struct conn served over a runtime port
         */
        function attach_port(port, info) {
            const conn = attach(Object.assign({
                send: function (msg) {
                    try {
                        port.postMessage(msg);
                    } catch (e) {
                        // port closed
                    }
                },
            }, info));
            port.onMessage.addListener(function (msg) {
                if (!msg || msg.id === undefined) {
                    return; // keepalive pings
                }
                handle(conn, msg.method, msg.args).then(function (value) {
                    conn.send({ re: msg.id, value: value === undefined ? null : value });
                }, function (e) {
                    conn.send({ re: msg.id, error: String((e && e.message) || e) });
                });
            });
            port.onDisconnect.addListener(function () {
                detach(conn);
            });
            return conn;
        }

        /*
         * handle(conn, method, args) -> Promise of the handler's result
         */
        async function handle(conn, method, args) {
            const fn = host.handlers[method];
            if (fn === undefined) {
                throw new Error('Moss: "' + method + '" is not available in this build');
            }
            const script = await opts.get_script(conn);
            if (script === null || script === undefined) {
                throw new Error('Moss: this script is disabled or unknown');
            }
            return fn(conn, script, args || []);
        }

        /*
         * require_grant(script, names, what) — throw unless the script has one of the grants
         */
        function require_grant(script, names, what) {
            if (host.policy.require_grants === false) {
                return;
            }
            for (const name of names) {
                if (script.grants.indexOf(name) >= 0) {
                    return;
                }
            }
            throw new Error('Moss: ' + what + ' needs "// @grant ' + names[0] + '" in the script header');
        }

        host.attach = attach;
        host.detach = detach;
        host.attach_port = attach_port;
        host.handle = handle;
        host.require_grant = require_grant;

        // Errors reported by a script; Moss shows them, exported extensions log them.
        host.handlers.error = function (conn, script, args) {
            if (opts.on_error) {
                opts.on_error(script, String(args[0]), conn);
            } else {
                console.error('[' + script.name + ']', args[0]);
            }
            return true;
        };

        for (const name of Object.keys(globalThis.moss_host_features)) {
            globalThis.moss_host_features[name](host);
        }
        return host;
    }

    globalThis.moss_host = moss_host;
})();
