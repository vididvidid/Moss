// moss/dom/wait — react to elements that appear later (SPAs, lazy content).
//   const el = await waitFor('#comments', { timeout: 10000 })   → element (rejects on timeout)
//   const stop = observe('.ad', (el) => el.remove())             → runs for current and future matches

exports.waitFor = function (selector, opts) {
  opts = opts || {};
  var root = opts.root || document;
  return new Promise(function (resolve, reject) {
    var found = root.querySelector(selector);
    if (found) return resolve(found);
    var timer = null;
    var mo = new MutationObserver(function () {
      var el = root.querySelector(selector);
      if (!el) return;
      mo.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    mo.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
    if (opts.timeout !== 0) {
      timer = setTimeout(function () {
        mo.disconnect();
        reject(new Error('waitFor("' + selector + '") timed out'));
      }, opts.timeout || 10000);
    }
  });
};

exports.observe = function (selector, callback, opts) {
  opts = opts || {};
  var root = opts.root || document;
  var seen = new WeakSet();
  function scan() {
    root.querySelectorAll(selector).forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el);
      callback(el);
    });
  }
  scan();
  var mo = new MutationObserver(scan);
  mo.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
  return function stop() { mo.disconnect(); };
};
