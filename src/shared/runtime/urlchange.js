/*
 * Feature: urlchange — Tampermonkey's window.onurlchange. Single-page apps change the
 * address without loading a page; the script hears about it through
 *     window.onurlchange = function (info) { info.url }   or
 *     window.addEventListener('urlchange', function (info) { info.url })
 * Changes are noticed through history events, the Navigation API where the browser has
 * it, and a light poll as a fallback.
 */
(function () {
    'use strict';
    const g = globalThis;
    if (!g.document || !g.location) {
        return;
    }
    let last = g.location.href;
    if (g.onurlchange === undefined) {
        g.onurlchange = null; // Tampermonkey sets this so scripts can test for support
    }

    /*
     * check() — fire the event if the address changed since last time
     */
    function check() {
        const now = g.location.href;
        if (now === last) {
            return;
        }
        last = now;
        const event = new Event('urlchange');
        event.url = now;
        if (typeof g.onurlchange === 'function') {
            try {
                g.onurlchange(event);
            } catch (e) {
                rt.report(e);
            }
        }
        g.dispatchEvent(event);
    }

    g.addEventListener('popstate', check);
    g.addEventListener('hashchange', check);
    if (g.navigation && typeof g.navigation.addEventListener === 'function') {
        g.navigation.addEventListener('navigatesuccess', check);
    }
    setInterval(check, 250);
})();
