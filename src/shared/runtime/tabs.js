/* Feature: tabs — GM_openInTab. Falls back to window.open without a bridge. */
(function () {
  // GM_openInTab(url, loadInBackground) or GM_openInTab(url, { active, insert })
  function open(url, opts) {
    if (typeof opts === 'boolean') opts = { active: !opts };
    opts = opts || {};
    var handle = { closed: false, close: function () {} };
    if (!M.transport) {
      var w = window.open(url, '_blank');
      handle.close = function () { handle.closed = true; if (w) w.close(); };
      return handle;
    }
    var tab = M.call('tabs.open', [String(url), { active: opts.active !== false, insert: opts.insert !== false }])
      .catch(function (e) { M.report(e); return null; });
    handle.close = function () {
      handle.closed = true;
      tab.then(function (id) { if (id != null) M.call('tabs.close', [id]).catch(M.report); });
    };
    return handle;
  }
  M.api.GM_openInTab = open;
  M.GM.openInTab = function (url, opts) { return Promise.resolve(open(url, opts)); };
})();
