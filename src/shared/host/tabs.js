/* Host feature: tabs — GM_openInTab; a script may only close tabs it opened. */
MossHostFeatures.tabs = function (H) {
  H.handlers['tabs.open'] = async function (c, s, a) {
    var opts = a[1] || {};
    var create = { url: a[0], active: opts.active !== false };
    if (c.tabId != null) create.openerTabId = c.tabId;
    var tab = await chrome.tabs.create(create);
    (c.opened = c.opened || new Set()).add(tab.id);
    return tab.id;
  };
  H.handlers['tabs.close'] = async function (c, s, a) {
    if (!c.opened || !c.opened.has(a[0])) throw new Error('Moss: a script can only close tabs it opened');
    c.opened.delete(a[0]);
    await chrome.tabs.remove(a[0]);
    return true;
  };
};
