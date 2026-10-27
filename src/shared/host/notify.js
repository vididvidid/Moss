/* Host feature: notify — chrome.notifications, with click/close routed back to the script. */
MossHostFeatures.notify = function (H) {
  var owners = new Map(); // notification id -> { conn, id }
  if (chrome.notifications) {
    chrome.notifications.onClicked.addListener(function (nid) {
      var o = owners.get(nid);
      if (o) o.conn.send({ push: 'notify', id: o.id, kind: 'click' });
    });
    chrome.notifications.onClosed.addListener(function (nid) {
      var o = owners.get(nid);
      if (!o) return;
      owners.delete(nid);
      o.conn.send({ push: 'notify', id: o.id, kind: 'close' });
    });
  }
  H.handlers.notify = async function (c, s, a) {
    var d = a[1] || {};
    var nid = await chrome.notifications.create({ type: 'basic', iconUrl: d.image || H.opts.icon,
      title: String(d.title || s.name), message: String(d.text || ''), silent: !!d.silent });
    owners.set(nid, { conn: c, id: a[0] });
    return nid;
  };
};
