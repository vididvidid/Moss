/* Transport: a long-lived port to the extension. Used by sandboxed (USER_SCRIPT world)
   scripts in Moss and by content scripts in exported extensions. */
(function () {
  var port = null, seq = 0, pending = {}, retries = 0;

  function open() {
    port = chrome.runtime.connect({ name: 'moss:' + M.ctx.id + ':' + (M.ctx.token || '') });
    port.onMessage.addListener(function (msg) {
      if (msg.re === undefined) return M.onPush(msg);
      var p = pending[msg.re];
      if (!p) return;
      delete pending[msg.re];
      retries = 0;
      if ('error' in msg) p.reject(new Error(msg.error)); else p.resolve(msg.value);
    });
    port.onDisconnect.addListener(function () {
      void chrome.runtime.lastError;
      port = null;
      var err = new Error('Moss: lost the connection to the extension');
      Object.keys(pending).forEach(function (id) { pending[id].reject(err); });
      pending = {};
      // The service worker is restarted from time to time; reconnect so menu
      // commands and event listeners survive it.
      if (retries++ < 5) setTimeout(M.reconnected, 200 * retries);
    });
  }

  M.transport = {
    call: function (method, args) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        try {
          if (!port) open();
          port.postMessage({ id: id, method: method, args: args });
        } catch (e) {
          delete pending[id];
          reject(e);
        }
      });
    },
  };
})();
