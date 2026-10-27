/* Feature: menu — GM_registerMenuCommand; commands show up in the toolbar popup. */
(function () {
  var seq = 0, items = {};

  M.push.menu = function (msg) {
    var it = items[msg.id];
    if (it) Promise.resolve().then(it.fn).catch(M.report);
  };
  M.resync.push(function () {
    Object.keys(items).forEach(function (id) { M.call('menu.register', [id, items[id].caption]).catch(M.report); });
  });

  function register(caption, fn, opts) {
    var id = (opts && typeof opts === 'object' && opts.id) || 'm' + (++seq);
    items[id] = { caption: String(caption), fn: fn };
    M.call('menu.register', [id, items[id].caption]).catch(M.report);
    return id;
  }
  function unregister(id) {
    if (!items[id]) return;
    delete items[id];
    M.call('menu.unregister', [id]).catch(M.report);
  }

  M.api.GM_registerMenuCommand = M.GM.registerMenuCommand = register;
  M.api.GM_unregisterMenuCommand = M.GM.unregisterMenuCommand = unregister;
})();
