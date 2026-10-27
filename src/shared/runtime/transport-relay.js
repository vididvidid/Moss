/*
 * Transport: page-mode scripts reach the extension through a relay (relay.js) that
 * runs in the sandboxed world of the same page. The two talk with synchronous DOM
 * events whose names contain the script's secret token, so page code can't listen in
 * or forge calls without knowing it.
 *
 * Page mode is injected at document_start (before any page script), so the DOM
 * functions used here are captured before the page could replace them.
 */
(function () {
    'use strict';
    const doc = document;
    const add_listener = EventTarget.prototype.addEventListener;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const make_event = CustomEvent;
    const to_json = JSON.stringify;
    const from_json = JSON.parse;
    const UP = 'moss-' + rt.ctx.token + '-up';
    const DOWN = 'moss-' + rt.ctx.token + '-down';
    let ready = false;
    let seq = 0;
    let pending = {};
    const queue = [];

    /*
     * send(msg) — hand a message to the relay
     */
    function send(msg) {
        dispatch.call(doc, new make_event(UP, { detail: to_json(msg) }));
    }

    /*
     * on_message(event) — readiness, answers, disconnects and pushes from the relay
     */
    function on_message(event) {
        const msg = from_json(event.detail);
        if (msg.ready) {
            if (!ready) {
                ready = true;
                while (queue.length > 0) {
                    send(queue.shift());
                }
            }
            return;
        }
        if (msg.disconnected) {
            const err = new Error('Moss: lost the connection to the extension');
            for (const id of Object.keys(pending)) {
                pending[id].reject(err);
            }
            pending = {};
            setTimeout(rt.reconnected, 200);
            return;
        }
        if (msg.re === undefined) {
            rt.on_push(msg);
            return;
        }
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
    }

    /*
     * call(method, args) -> Promise of the extension's answer
     */
    function call(method, args) {
        return new Promise(function (resolve, reject) {
            seq++;
            const msg = { id: seq, method: method, args: args };
            pending[seq] = { resolve: resolve, reject: reject };
            if (ready) {
                send(msg);
            } else {
                queue.push(msg);
            }
        });
    }

    add_listener.call(doc, DOWN, on_message);
    send({ hello: true }); // answered at once if the relay is already there
    rt.transport = { call: call };
})();
