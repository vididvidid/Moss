/* Transport: postMessage to the parent frame. Used by extension-mode scripts in Moss,
   which run in a sandboxed iframe inside the offscreen runner. */
(function () {
  var g = globalThis, seq = 0, pending = {};

  g.addEventListener('message', function (e) {
    if (e.source !== g.parent || !e.data || !e.data.moss) return;
    var msg = e.data.moss;
    if (msg.re !== undefined) {
      var p = pending[msg.re];
      if (!p) return;
      delete pending[msg.re];
      if ('error' in msg) p.reject(new Error(msg.error)); else p.resolve(msg.value);
    } else if (msg.disconnected) {
      var err = new Error('Moss: lost the connection to the extension');
      Object.keys(pending).forEach(function (id) { pending[id].reject(err); });
      pending = {};
      setTimeout(M.reconnected, 200);
    } else if (msg.push) {
      M.onPush(msg);
    }
  });

  M.transport = {
    call: function (method, args) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        g.parent.postMessage({ moss: { id: id, method: method, args: args } }, '*');
      });
    },
  };
})();
