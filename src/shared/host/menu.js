/* Host feature: menu — collects menu commands per connection for the toolbar popup. */
MossHostFeatures.menu = function (H) {
  H.handlers['menu.register'] = function (c, s, a) { c.menu.set(a[0], a[1]); return true; };
  H.handlers['menu.unregister'] = function (c, s, a) { c.menu.delete(a[0]); return true; };

  // Commands for a tab, plus those of background scripts (tabId null).
  H.listMenus = function (tabId) {
    var out = [];
    H.conns.forEach(function (c) {
      if (c.tabId !== tabId && c.tabId != null) return;
      c.menu.forEach(function (caption, id) {
        out.push({ conn: c.key, id: id, caption: caption, scriptId: c.scriptId, background: c.tabId == null });
      });
    });
    return out;
  };
  H.runMenu = function (connKey, id) {
    var c = H.conns.get(connKey);
    if (!c || !c.menu.has(id)) return false;
    c.send({ push: 'menu', id: id });
    return true;
  };
};
