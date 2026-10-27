// moss/dom/util — small timing helpers.
exports.debounce = function (fn, ms) {
  var t;
  return function () {
    var self = this, args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, args); }, ms);
  };
};
exports.throttle = function (fn, ms) {
  var last = 0;
  return function () {
    var now = Date.now();
    if (now - last < ms) return;
    last = now;
    return fn.apply(this, arguments);
  };
};
exports.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
