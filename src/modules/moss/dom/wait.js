'use strict';
/*
 * moss/dom/wait — react to elements that appear later (SPAs, lazy content).
 *     const el = await wait_for('#comments', { timeout: 10000 });   → element (rejects on timeout)
 *     const stop = observe('.ad', function (el) { el.remove(); });   → current and future matches
 */

/*
 * watched_node(root) -> what a MutationObserver should watch for root
 */
function watched_node(root) {
    return root === document ? document.documentElement : root;
}

/*
 * wait_for(selector, opts) -> Promise of the first element matching selector
 *   opts: { timeout: ms (0 = forever, default 10000), root }
 */
function wait_for(selector, opts) {
    const o = opts || {};
    const root = o.root || document;
    return new Promise(function (resolve, reject) {
        const found = root.querySelector(selector);
        if (found !== null) {
            resolve(found);
            return;
        }
        let timer = null;
        const observer = new MutationObserver(function () {
            const el = root.querySelector(selector);
            if (el === null) {
                return;
            }
            observer.disconnect();
            clearTimeout(timer);
            resolve(el);
        });
        observer.observe(watched_node(root), { childList: true, subtree: true });
        if (o.timeout !== 0) {
            timer = setTimeout(function () {
                observer.disconnect();
                reject(new Error('wait_for("' + selector + '") timed out'));
            }, o.timeout || 10000);
        }
    });
}

/*
 * observe(selector, callback, opts) -> stop(); calls callback once per matching element,
 * now and whenever a new one appears
 */
function observe(selector, callback, opts) {
    const o = opts || {};
    const root = o.root || document;
    const seen = new WeakSet();

    /*
     * scan() — call back for every match not seen before
     */
    function scan() {
        for (const el of root.querySelectorAll(selector)) {
            if (!seen.has(el)) {
                seen.add(el);
                callback(el);
            }
        }
    }

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(watched_node(root), { childList: true, subtree: true });
    return function stop() {
        observer.disconnect();
    };
}

exports.wait_for = wait_for;
exports.observe = observe;
