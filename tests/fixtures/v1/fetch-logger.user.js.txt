// ==UserScript==
// @name         Fetch logger
// @namespace    moss.examples
// @version      1.0.0
// @description  Logs every fetch() the page makes. Needs page mode: a sandbox can't see the page's own fetch.
// @folder       Examples
// @match        https://example.com/*
// @sandbox      page
// @run-at       document-start
// ==/UserScript==

const original = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  console.log('%c[fetch]', 'color:#4a7c34;font-weight:bold', (init && init.method) || 'GET', url);
  return original.apply(this, arguments);
};
