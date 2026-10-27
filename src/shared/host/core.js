/* Moss API host core — the privileged side of the runtime. Feature files register
   handlers with MossHostFeatures.<name> = function (H) {...}. Moss's service worker
   loads every feature; an exported extension gets this core plus only the features
   its script uses. */
(function () {
  var features = globalThis.MossHostFeatures = globalThis.MossHostFeatures || {};

  globalThis.MossHost = function MossHost(opts) {
    // opts.getScript(conn) -> Promise<{ id, name, grants, connect } | null>
    // opts.policy -> { requireGrants, requireConnect, chromeNamespaces }
    // opts.icon -> default notification icon URL
    // opts.onError(script, message, conn) -> optional, called for script errors
    var H = { opts: opts, policy: opts.policy || {}, handlers: {}, conns: new Map(), seq: 0 };

    H.attach = function (info) {
      var conn = Object.assign({ key: 'c' + (++H.seq), menu: new Map(), subs: new Map() }, info);
      H.conns.set(conn.key, conn);
      return conn;
    };
    H.detach = function (conn) {
      conn.subs.forEach(function (off) { try { off(); } catch (e) { /* already gone */ } });
      H.conns.delete(conn.key);
    };
    H.attachPort = function (port, info) {
      var conn = H.attach(Object.assign({
        send: function (msg) { try { port.postMessage(msg); } catch (e) { /* port closed */ } },
      }, info));
      port.onMessage.addListener(function (msg) {
        if (!msg || msg.id === undefined) return; // keepalive pings
        H.handle(conn, msg.method, msg.args).then(
          function (value) { conn.send({ re: msg.id, value: value === undefined ? null : value }); },
          function (e) { conn.send({ re: msg.id, error: String((e && e.message) || e) }); });
      });
      port.onDisconnect.addListener(function () { H.detach(conn); });
      return conn;
    };

    H.handle = async function (conn, method, args) {
      var fn = H.handlers[method];
      if (!fn) throw new Error('Moss: "' + method + '" is not available in this build');
      var script = await opts.getScript(conn);
      if (!script) throw new Error('Moss: this script is disabled or unknown');
      return fn(conn, script, args || []);
    };

    H.requireGrant = function (script, names, what) {
      if (H.policy.requireGrants === false) return;
      if (!names.some(function (n) { return script.grants.indexOf(n) >= 0; })) {
        throw new Error('Moss: ' + what + ' needs "// @grant ' + names[0] + '" in the script header');
      }
    };

    // Errors reported by a script; Moss shows them, exported extensions log them.
    H.handlers.error = function (conn, script, args) {
      if (opts.onError) opts.onError(script, String(args[0]), conn);
      else console.error('[' + script.name + ']', args[0]);
      return true;
    };

    Object.keys(features).forEach(function (name) { features[name](H); });
    return H;
  };
})();
