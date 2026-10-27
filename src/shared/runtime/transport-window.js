/*
 * Transport: postMessage to the parent frame. Used by extension-mode scripts in Moss,
 * which run in a sandboxed iframe inside the offscreen runner (src/runner/).
 */
(function () {
    'use strict';
    const g = globalThis;
    let seq = 0;
    let pending = {};

    /*
     * on_message(event) — answers, disconnect notices and pushes from the runner
     */
    function on_message(event) {
        if (event.source !== g.parent || !event.data || !event.data.moss) {
            return;
        }
        const msg = event.data.moss;
        if (msg.re !== undefined) {
            const p = pending[msg.re];
            if (p === undefined) {
                return;
            }
            delete pending[msg.re];
            if ('error' in msg) {
                p.reject(new Error(msg.error));
            } else {
                p.resolve(msg.value);
            }
        } else if (msg.disconnected) {
            const err = new Error('Moss: lost the connection to the extension');
            for (const id of Object.keys(pending)) {
                pending[id].reject(err);
            }
            pending = {};
            setTimeout(rt.reconnected, 200);
        } else if (msg.push) {
            rt.on_push(msg);
        }
    }

    /*
     * call(method, args) -> Promise of the extension's answer
     */
    function call(method, args) {
        return new Promise(function (resolve, reject) {
            seq++;
            const id = seq;
            pending[id] = { resolve: resolve, reject: reject };
            g.parent.postMessage({ moss: { id: id, method: method, args: args } }, '*');
        });
    }

    g.addEventListener('message', on_message);
    rt.transport = { call: call };
})();
