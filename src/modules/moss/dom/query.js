'use strict';
/*
 * moss/dom/query — $, $$ and ready().
 */

/*
 * $(selector, root) -> the first matching element, or null
 */
function $(selector, root) {
    return (root || document).querySelector(selector);
}

/*
 * $$(selector, root) -> every matching element, as an array
 */
function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
}

/*
 * ready() -> Promise, resolved once the DOM is parsed (immediately if it already is)
 */
function ready() {
    return new Promise(function (resolve) {
        if (document.readyState !== 'loading') {
            resolve();
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                resolve();
            }, { once: true });
        }
    });
}

exports.$ = $;
exports.$$ = $$;
exports.ready = ready;
