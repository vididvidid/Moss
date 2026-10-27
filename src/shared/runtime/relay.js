/*
 * Relay for page-mode scripts: runs in the sandboxed (USER_SCRIPT / ISOLATED) world of
 * the same page and passes messages between the page-mode script (transport-relay.js)
 * and the extension. Built by build_relay() in src/lib/bundler.js, which calls
 * moss_relay({ id, token }).
 */
function moss_relay(ctx) {
    'use strict';
    const UP = 'moss-' + ctx.token + '-up';
    const DOWN = 'moss-' + ctx.token + '-down';
    let port = null;

    /*
     * emit(msg) — hand a message to the page-mode script
     */
    function emit(msg) {
        document.dispatchEvent(new CustomEvent(DOWN, { detail: JSON.stringify(msg) }));
    }

    /*
     * open() — connect to the extension under the script's id and token
     */
    function open() {
        port = chrome.runtime.connect({ name: 'moss:' + ctx.id + ':' + ctx.token });
        port.onMessage.addListener(emit);
        port.onDisconnect.addListener(function () {
            void chrome.runtime.lastError;
            port = null;
            emit({ disconnected: true });
        });
    }

    document.addEventListener(UP, function (event) {
        const msg = JSON.parse(event.detail);
        if (msg.hello) {
            emit({ ready: true });
            return;
        }
        try {
            if (port === null) {
                open();
            }
            port.postMessage(msg);
        } catch (e) {
            emit({ re: msg.id, error: String(e.message || e) });
        }
    });
    emit({ ready: true }); // in case the page-mode script started first
}
