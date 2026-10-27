/* Feature: chrome — grant-checked browser APIs:
     await moss.chrome.history.search({ text: '' })
     moss.chrome.history.onVisited.addListener(fn)
   Each namespace needs "// @grant chrome.<namespace>". In an exported background
   script this is simply the real `chrome` object. */
(function () {
  if (M.ctx.nativeChrome) { M.moss.chrome = globalThis.chrome; return; }

  var seq = 0, subs = {};
  M.push.event = function (msg) {
    var s = subs[msg.id];
    if (s) Promise.resolve().then(function () { return s.fn.apply(null, msg.args); }).catch(M.report);
  };
  M.resync.push(function () {
    Object.keys(subs).forEach(function (id) { M.call('chrome.listen', [subs[id].path, id]).catch(M.report); });
  });

  function event(path) {
    function find(fn) { return Object.keys(subs).filter(function (id) { return subs[id].path === path && subs[id].fn === fn; }); }
    return {
      addListener: function (fn) {
        var id = 'e' + (++seq);
        subs[id] = { path: path, fn: fn };
        M.call('chrome.listen', [path, id]).catch(M.report);
      },
      removeListener: function (fn) {
        find(fn).forEach(function (id) { delete subs[id]; M.call('chrome.unlisten', [id]).catch(M.report); });
      },
      hasListener: function (fn) { return find(fn).length > 0; },
    };
  }

  function node(path) {
    return new Proxy(function () {}, {
      get: function (_, key) {
        if (typeof key !== 'string' || key === 'then') return undefined;
        var next = path.concat(key);
        return /^on[A-Z]/.test(key) ? event(next.join('.')) : node(next);
      },
      apply: function (_, __, args) { return M.call('chrome', [path.join('.'), args]); },
    });
  }
  M.moss.chrome = node([]);
})();
