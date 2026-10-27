// moss/dom/url — onUrlChange(fn): fires on single-page-app navigations.
// Uses the Navigation API where present, with popstate + polling as a fallback
// (history.pushState patches made in a sandbox don't see the page's own calls).
//   const stop = onUrlChange((url, previous) => { … })
exports.onUrlChange = function (callback, opts) {
  var last = location.href;
  function check() {
    if (location.href === last) return;
    var prev = last;
    last = location.href;
    callback(last, prev);
  }
  var nav = window.navigation;
  if (nav) nav.addEventListener('navigatesuccess', check);
  window.addEventListener('popstate', check);
  var timer = setInterval(check, (opts && opts.interval) || 500);
  return function stop() {
    if (nav) nav.removeEventListener('navigatesuccess', check);
    window.removeEventListener('popstate', check);
    clearInterval(timer);
  };
};
