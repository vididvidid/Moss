/*
 * Transport: direct calls into the API host living in the same service worker.
 * Used by background scripts in exported extensions.
 */
(function () {
    'use strict';
    const host = globalThis.moss_host_instance;
    const conn = host.attach({
        script_id: rt.ctx.id,
        tab_id: null,
        send: function (msg) {
            rt.on_push(msg);
        },
    });

    rt.transport = {
        call: function (method, args) {
            return host.handle(conn, method, args);
        },
    };
})();
