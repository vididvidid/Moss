/*
 * Feature: values — GM_getValue & friends. Values are preloaded before the script
 * starts so the synchronous API works. Without an extension bridge they live in the
 * page's localStorage under "moss:<script id>:".
 *
 * GM_addValueChangeListener(key, fn) calls fn(key, old_value, new_value, remote) when
 * the value changes here (remote false) or in another tab of the same script (remote
 * true — the extension pushes those changes, and the cached copy is updated too).
 */
(function () {
    'use strict';
    const api = rt.api;
    const gm = rt.gm;
    const bridged = rt.transport !== null && rt.ctx.values_backend !== 'local';
    const prefix = 'moss:' + rt.ctx.id + ':';
    let values = rt.ctx.values_snapshot ? clone(rt.ctx.values_snapshot) : {};
    const written_early = {}; // keys changed before the live values arrived
    let listener_seq = 0;
    const listeners = {}; // id -> { key, fn }

    /*
     * clone(value) -> a deep copy (values are JSON, like Tampermonkey's)
     */
    function clone(value) {
        if (value === undefined) {
            return undefined;
        }
        return JSON.parse(JSON.stringify(value));
    }

    /*
     * load_local() — read this script's values from localStorage
     */
    function load_local() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.indexOf(prefix) === 0) {
                    values[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key));
                }
            }
        } catch (e) {
            // no localStorage here
        }
    }

    let loaded;
    if (bridged) {
        loaded = rt.call('values.load').then(function (stored) {
            // Live values replace the snapshot; anything written meanwhile wins.
            const fresh = stored || {};
            for (const key of Object.keys(written_early)) {
                if (written_early[key] === undefined) {
                    delete fresh[key];
                } else {
                    fresh[key] = written_early[key];
                }
            }
            values = fresh;
        });
    } else {
        load_local();
        loaded = Promise.resolve();
    }
    rt.waits.push(loaded);

    /*
     * persist(key, value) -> Promise; value undefined deletes the key
     */
    function persist(key, value) {
        if (bridged) {
            if (value === undefined) {
                return rt.call('values.delete', [key]);
            }
            return rt.call('values.set', [key, value]);
        }
        try {
            if (value === undefined) {
                localStorage.removeItem(prefix + key);
            } else {
                localStorage.setItem(prefix + key, JSON.stringify(value));
            }
        } catch (e) {
            return Promise.reject(e);
        }
        return Promise.resolve();
    }

    /*
     * notify(key, old_value, new_value, remote) — call the listeners for key
     */
    function notify(key, old_value, new_value, remote) {
        for (const id of Object.keys(listeners)) {
            if (listeners[id].key !== key) {
                continue;
            }
            try {
                listeners[id].fn(key, clone(old_value), clone(new_value), remote);
            } catch (e) {
                rt.report(e);
            }
        }
    }

    /*
     * change(key, value, remote) — update the cache (value undefined = deleted) and tell listeners
     */
    function change(key, value, remote) {
        const old_value = values[key];
        if (!remote && rt.ctx.early) {
            written_early[key] = clone(value);
        }
        if (value === undefined) {
            delete values[key];
        } else {
            values[key] = clone(value);
        }
        if (JSON.stringify(old_value) !== JSON.stringify(value)) {
            notify(key, old_value, value, remote);
        }
    }

    // Another tab of this script changed a value.
    rt.push.value = function (msg) {
        change(msg.key, msg.deleted ? undefined : msg.value, true);
    };

    /*
     * add_listener(key, fn) -> listener id
     */
    function add_listener(key, fn) {
        listener_seq++;
        const id = 'v' + listener_seq;
        listeners[id] = { key: String(key), fn: fn };
        return id;
    }

    /*
     * remove_listener(id) — stop listening
     */
    function remove_listener(id) {
        delete listeners[id];
    }

    /*
     * get_value(key, fallback) -> the stored value, or fallback
     */
    function get_value(key, fallback) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return clone(values[key]);
        }
        return fallback;
    }

    /*
     * set_value(key, value) — store a value (written through in the background)
     */
    function set_value(key, value) {
        change(key, value, false);
        persist(key, values[key]).catch(rt.report);
    }

    /*
     * delete_value(key) — forget a value
     */
    function delete_value(key) {
        change(key, undefined, false);
        persist(key, undefined).catch(rt.report);
    }

    /*
     * list_values() -> every stored key
     */
    function list_values() {
        return Object.keys(values);
    }

    api.GM_getValue = get_value;
    api.GM_setValue = set_value;
    api.GM_deleteValue = delete_value;
    api.GM_listValues = list_values;
    api.GM_addValueChangeListener = add_listener;
    api.GM_removeValueChangeListener = remove_listener;

    gm.getValue = function (key, fallback) {
        return loaded.then(function () {
            return get_value(key, fallback);
        });
    };
    gm.setValue = function (key, value) {
        change(key, value, false);
        return persist(key, values[key]);
    };
    gm.deleteValue = function (key) {
        change(key, undefined, false);
        return persist(key, undefined);
    };
    gm.addValueChangeListener = function (key, fn) {
        return Promise.resolve(add_listener(key, fn));
    };
    gm.removeValueChangeListener = function (id) {
        remove_listener(id);
        return Promise.resolve();
    };
    gm.listValues = function () {
        return loaded.then(list_values);
    };
})();
