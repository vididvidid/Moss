// moss/dom/query — $, $$ and ready().
exports.$ = function (selector, root) { return (root || document).querySelector(selector); };
exports.$$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
// Resolves once the DOM is parsed (immediately if it already is).
exports.ready = function () {
  return new Promise(function (resolve) {
    if (document.readyState !== 'loading') resolve();
    else document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
  });
};
