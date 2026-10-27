/*
 * Feature: values — GM_getValue & friends. Values are preloaded before the script
 * starts so the synchronous API works. Without an extension bridge (page mode) they
 * live in the page's localStorage under "moss:<script id>:".
 */
(function () {
    'use strict';
    const api = rt.api;
    const gm = rt.gm;
    const bridged = rt.transport !== null && rt.ctx.values_backend !== 'local';
    const prefix = 'moss:' + rt.ctx.id + ':';
    let values = {};

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
            values = stored || {};
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
        values[key] = clone(value);
        persist(key, values[key]).catch(rt.report);
    }

    /*
     * delete_value(key) — forget a value
     */
    function delete_value(key) {
        delete values[key];
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

    gm.getValue = function (key, fallback) {
        return loaded.then(function () {
            return get_value(key, fallback);
        });
    };
    gm.setValue = function (key, value) {
        values[key] = clone(value);
        return persist(key, values[key]);
    };
    gm.deleteValue = function (key) {
        delete values[key];
        return persist(key, undefined);
    };
    gm.listValues = function () {
        return loaded.then(list_values);
    };
})();
