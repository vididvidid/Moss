'use strict';
/*
 * moss/dom/url — on_url_change(fn): fires on single-page-app navigations.
 * Uses the Navigation API where present, with popstate + polling as a fallback
 * (history.pushState patches made in a sandbox don't see the page's own calls).
 *     const stop = on_url_change(function (url, previous) { … });
 */

/*
 * on_url_change(callback, opts) -> stop()
 *   opts: { interval: polling interval in ms (default 500) }
 */
function on_url_change(callback, opts) {
    let last = location.href;
    const nav = window.navigation;

    /*
     * check() — call back if the URL changed since last time
     */
    function check() {
        if (location.href === last) {
            return;
        }
        const previous = last;
        last = location.href;
        callback(last, previous);
    }

    if (nav) {
        nav.addEventListener('navigatesuccess', check);
    }
    window.addEventListener('popstate', check);
    const timer = setInterval(check, (opts && opts.interval) || 500);
    return function stop() {
        if (nav) {
            nav.removeEventListener('navigatesuccess', check);
        }
        window.removeEventListener('popstate', check);
        clearInterval(timer);
    };
}

exports.on_url_change = on_url_change;
