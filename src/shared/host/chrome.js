/*
 * Host feature: chrome — generic, grant-checked access to chrome.<namespace>.<member>,
 * including event subscriptions forwarded to the script.
 */
moss_host_features.chrome = function (host) {
    'use strict';
    const SAFE = /^[A-Za-z][A-Za-z0-9]*$/;

    /*
     * resolve(script, path) -> { parent, member } for "ns.member" after the grant checks
     */
    function resolve(script, path) {
        const parts = String(path).split('.');
        let safe = parts.length >= 2;
        for (const part of parts) {
            if (!SAFE.test(part)) {
                safe = false;
            }
        }
        if (!safe) {
            throw new Error('Moss: invalid chrome API path "' + path + '"');
        }
        const ns = parts[0];
        const allowed = host.policy.chrome_namespaces;
        if (allowed && allowed.indexOf(ns) < 0) {
            throw new Error('Moss: chrome.' + ns + ' is not enabled (Moss Settings → Security)');
        }
        const granted = script.grants.indexOf('chrome.' + ns) >= 0 || script.grants.indexOf('chrome.' + parts[0] + '.' + parts[1]) >= 0;
        if (!granted) {
            throw new Error('Moss: add "// @grant chrome.' + ns + '" to use chrome.' + path);
        }
        let parent = chrome[ns];
        if (!parent) {
            throw new Error('Moss: chrome.' + ns + ' is unavailable — the "' + ns + '" permission is missing. Re-save the script to grant it.');
        }
        for (let i = 1; i < parts.length - 1; i++) {
            parent = parent[parts[i]];
            if (!parent) {
                throw new Error('Moss: chrome.' + path + ' does not exist');
            }
        }
        return { parent: parent, member: parent[parts[parts.length - 1]] };
    }

    host.handlers.chrome = async function (conn, script, args) {
        const r = resolve(script, args[0]);
        if (typeof r.member !== 'function') {
            if (r.member === undefined) {
                throw new Error('Moss: chrome.' + args[0] + ' does not exist');
            }
            return r.member; // constants such as chrome.tabs.TAB_ID_NONE
        }
        return r.member.apply(r.parent, args[1] || []);
    };

    host.handlers['chrome.listen'] = function (conn, script, args) {
        const ev = resolve(script, args[0]).member;
        const id = args[1];
        if (!ev || typeof ev.addListener !== 'function') {
            throw new Error('Moss: chrome.' + args[0] + ' is not an event');
        }
        if (conn.subs.has(id)) {
            conn.subs.get(id)();
        }
        const fn = function () {
            conn.send({ push: 'event', id: id, args: Array.prototype.slice.call(arguments) });
        };
        ev.addListener(fn);
        conn.subs.set(id, function () {
            ev.removeListener(fn);
        });
        return true;
    };

    host.handlers['chrome.unlisten'] = function (conn, script, args) {
        const unsubscribe = conn.subs.get(args[0]);
        if (unsubscribe !== undefined) {
            unsubscribe();
            conn.subs.delete(args[0]);
        }
        return true;
    };
};
