// ==UserScript==
// @name         Fetch logger
// @namespace    moss.examples
// @version      1.1.0
// @description  Logs every fetch() the page makes. Needs page mode: a sandbox can't see the page's own fetch.
// @folder       Examples
// @match        https://example.com/*
// @sandbox      page
// @run-at       document-start
// @strict
// ==/UserScript==

const original_fetch = window.fetch;

/*
 * logged_fetch(input, init) -> the page's own fetch(), after logging the request
 */
function logged_fetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    console.log('%c[fetch]', 'color:#4a7c34;font-weight:bold', method, url);
    return original_fetch.apply(window, arguments);
}

window.fetch = logged_fetch;
