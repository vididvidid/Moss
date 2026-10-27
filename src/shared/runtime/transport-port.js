/*
 * Transport: a long-lived port to the extension. Used by sandboxed (USER_SCRIPT world)
 * scripts in Moss and by content scripts in exported extensions.
 *
 * Port protocol:  script → extension  { id, method, args }
 *                 extension → script  { re: id, value } | { re: id, error } | { push: kind, … }
 */
(function () {
    'use strict';
    let port = null;
    let seq = 0;
    let pending = {};
    let retries = 0;

    /*
     * on_message(msg) — settle a pending call, or hand a push to the runtime
     */
    function on_message(msg) {
        if (msg.re === undefined) {
            rt.on_push(msg);
            return;
        }
        const p = pending[msg.re];
        if (p === undefined) {
            return;
        }
        delete pending[msg.re];
        retries = 0;
        if ('error' in msg) {
            p.reject(new Error(msg.error));
        } else {
            p.resolve(msg.value);
        }
    }

    /*
     * on_disconnect() — fail pending calls; reconnect so menus and listeners survive
     * a service worker restart
     */
    function on_disconnect() {
        void chrome.runtime.lastError;
        port = null;
        const err = new Error('Moss: lost the connection to the extension');
        for (const id of Object.keys(pending)) {
            pending[id].reject(err);
        }
        pending = {};
        retries++;
        if (retries <= 5) {
            setTimeout(rt.reconnected, 200 * retries);
        }
    }

    /*
     * open() — connect, naming the port after the script and its secret token
     */
    function open() {
        port = chrome.runtime.connect({ name: 'moss:' + rt.ctx.id + ':' + (rt.ctx.token || '') });
        port.onMessage.addListener(on_message);
        port.onDisconnect.addListener(on_disconnect);
    }

    /*
     * call(method, args) -> Promise of the extension's answer
     */
    function call(method, args) {
        return new Promise(function (resolve, reject) {
            seq++;
            const id = seq;
            pending[id] = { resolve: resolve, reject: reject };
            try {
                if (port === null) {
                    open();
                }
                port.postMessage({ id: id, method: method, args: args });
            } catch (e) {
                delete pending[id];
                reject(e);
            }
        });
    }

    rt.transport = { call: call };
})();
