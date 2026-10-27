/*
 * Feature: notify — GM_notification as a real system notification.
 */
(function () {
    'use strict';
    let seq = 0;
    const handlers = {};

    rt.push.notify = function (msg) {
        const h = handlers[msg.id];
        if (h === undefined) {
            return;
        }
        if (msg.kind === 'click' && h.onclick) {
            h.onclick();
        }
        if (msg.kind === 'close') {
            delete handlers[msg.id];
            if (h.ondone) {
                h.ondone();
            }
        }
    };

    /*
     * notify(details, ondone) or notify(text, title, image, onclick) -> Promise of the id
     */
    function notify(a, b, c, d) {
        let details;
        if (typeof a === 'string') {
            details = { text: a, title: b, image: c, onclick: d };
        } else {
            details = Object.assign({}, a);
            if (b) {
                details.ondone = b;
            }
        }
        seq++;
        const id = 'n' + seq;
        handlers[id] = { onclick: details.onclick, ondone: details.ondone };
        return rt.call('notify', [id, { title: details.title, text: details.text, image: details.image, silent: !!details.silent }]);
    }

    rt.api.GM_notification = function (a, b, c, d) {
        notify(a, b, c, d).catch(rt.report);
    };
    rt.gm.notification = notify;
})();
