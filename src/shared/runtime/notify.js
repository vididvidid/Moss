/* Feature: notify — GM_notification as a real system notification. */
(function () {
  var seq = 0, handlers = {};

  M.push.notify = function (msg) {
    var h = handlers[msg.id];
    if (!h) return;
    if (msg.kind === 'click' && h.onclick) h.onclick();
    if (msg.kind === 'close') { delete handlers[msg.id]; if (h.ondone) h.ondone(); }
  };

  // GM_notification(details, ondone) or GM_notification(text, title, image, onclick)
  function notify(a, b, c, d) {
    var details = typeof a === 'string' ? { text: a, title: b, image: c, onclick: d } : Object.assign({}, a, b ? { ondone: b } : null);
    var id = 'n' + (++seq);
    handlers[id] = { onclick: details.onclick, ondone: details.ondone };
    return M.call('notify', [id, { title: details.title, text: details.text, image: details.image, silent: !!details.silent }]);
  }

  M.api.GM_notification = function () { notify.apply(null, arguments).catch(M.report); };
  M.GM.notification = notify;
})();
