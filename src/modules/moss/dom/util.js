'use strict';
/*
 * moss/dom/util — small timing helpers.
 */

/*
 * debounce(fn, ms) -> a function that runs fn once calls stop for ms
 */
function debounce(fn, ms) {
    let timer = null;
    return function () {
        const args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () {
            fn.apply(null, args);
        }, ms);
    };
}

/*
 * throttle(fn, ms) -> a function that runs fn at most once every ms
 */
function throttle(fn, ms) {
    let last = 0;
    return function () {
        const now = Date.now();
        if (now - last < ms) {
            return undefined;
        }
        last = now;
        return fn.apply(null, arguments);
    };
}

/*
 * sleep(ms) -> Promise resolved after ms
 */
function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

exports.debounce = debounce;
exports.throttle = throttle;
exports.sleep = sleep;
