/* Feature: style — GM_addStyle / GM_addElement. Purely local, no bridge needed. */
(function () {
  function parent() { return document.head || document.documentElement; }

  M.api.GM_addStyle = function (css) {
    var el = document.createElement('style');
    el.textContent = String(css);
    parent().appendChild(el);
    return el;
  };
  // GM_addElement(tag, attrs) or GM_addElement(parentNode, tag, attrs)
  M.api.GM_addElement = function (a, b, c) {
    var into = typeof a === 'string' ? parent() : a;
    var tag = typeof a === 'string' ? a : b;
    var attrs = (typeof a === 'string' ? b : c) || {};
    var el = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) {
      if (k === 'textContent') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    into.appendChild(el);
    return el;
  };
  M.GM.addStyle = function (css) { return Promise.resolve(M.api.GM_addStyle(css)); };
  M.GM.addElement = function () { return Promise.resolve(M.api.GM_addElement.apply(null, arguments)); };
})();
