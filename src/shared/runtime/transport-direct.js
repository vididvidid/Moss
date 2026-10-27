/* Transport: direct calls into the API host living in the same service worker.
   Used by background scripts in exported extensions. */
(function () {
  var host = globalThis.__mossHost;
  var conn = host.attach({ scriptId: M.ctx.id, tabId: null, send: function (msg) { M.onPush(msg); } });
  M.transport = { call: function (method, args) { return host.handle(conn, method, args); } };
})();
