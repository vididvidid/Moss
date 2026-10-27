/*
 * Host feature: values — per-script storage in chrome.storage.local ("values:<id>").
 */
moss_host_features.values = function (host) {
    'use strict';
    const area = chrome.storage.local;
    const queues = {};

    /*
     * key_of(script) -> storage key of the script's values
     */
    function key_of(script) {
        return 'values:' + script.id;
    }

    /*
     * update(script, change) -> Promise; change(values) edits the stored object.
     * Writes are serialised per script so rapid GM_setValue calls never race.
     */
    function update(script, change) {
        const key = key_of(script);
        const before = queues[key] || Promise.resolve();
        const next = before.then(async function () {
            const got = await area.get(key);
            const values = got[key] || {};
            change(values);
            const patch = {};
            patch[key] = values;
            await area.set(patch);
        });
        queues[key] = next.catch(function () {});
        return next;
    }

    host.handlers['values.load'] = async function (conn, script) {
        const got = await area.get(key_of(script));
        return got[key_of(script)] || {};
    };
    /*
     * broadcast(from, msg) — tell the script's other open tabs about a change
     */
    function broadcast(from, msg) {
        for (const conn of host.conns.values()) {
            if (conn !== from && conn.script_id === from.script_id) {
                conn.send(msg);
            }
        }
    }

    host.handlers['values.set'] = async function (conn, script, args) {
        await update(script, function (values) {
            values[args[0]] = args[1];
        });
        broadcast(conn, { push: 'value', key: args[0], value: args[1], deleted: false });
        if (host.opts.on_values_change) {
            host.opts.on_values_change(script.id);
        }
    };
    host.handlers['values.delete'] = async function (conn, script, args) {
        await update(script, function (values) {
            delete values[args[0]];
        });
        broadcast(conn, { push: 'value', key: args[0], value: null, deleted: true });
        if (host.opts.on_values_change) {
            host.opts.on_values_change(script.id);
        }
    };
};
