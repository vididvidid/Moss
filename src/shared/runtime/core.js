/* Moss runtime core — always injected first. The bundler appends exactly one
   transport-*.js and only the feature files the script uses; each of those
   extends the `M` object created here. Plain ES2020, no imports: this file runs
   in user-script worlds, page worlds, sandboxed iframes and service workers. */
function MossCore(ctx) {
  var g = globalThis;
  if (ctx.filter && g.location && !MossCore.urlAllowed(ctx.filter, g.location.href)) return null;

  var tag = '[' + (ctx.logPrefix || 'Moss') + ': ' + ctx.info.name + ']';
  var M = {
    ctx: ctx,
    api: {},        // GM_* functions, handed to the script as parameters
    GM: {},         // GM.* promise API
    transport: null, // set by transport-*.js; null = no extension bridge
    waits: [],      // promises to settle before the script starts
    push: {},       // handlers for messages pushed by the extension
    resync: [],     // re-run after reconnecting (menus, listeners)
    mods: {},
  };

  M.log = function () { console.log.apply(console, [tag].concat([].slice.call(arguments))); };
  M.report = function (e) {
    if (ctx.logErrors !== false) console.error(tag, e);
    // Also tell the extension, so errors in background scripts and menu commands
    // show up in Moss instead of a console nobody is looking at.
    if (M.transport) M.transport.call('error', [String((e && e.stack) || e)]).catch(function () {});
  };

  M.call = function (method, args) {
    if (!M.transport) {
      return Promise.reject(new Error('Moss: "' + method + '" needs the extension bridge, which ' +
        (ctx.mode === 'page' ? 'page mode does not have (use @sandbox isolated).' : 'is not bundled.')));
    }
    return M.transport.call(method, args || []);
  };
  M.onPush = function (msg) {
    var handler = M.push[msg.push];
    if (handler) try { handler(msg); } catch (e) { M.report(e); }
  };
  M.reconnected = function () {
    M.resync.forEach(function (fn) { try { fn(); } catch (e) { M.report(e); } });
  };

  M.define = function (name, factory) { M.mods[name] = { factory: factory, module: null }; };
  M.require = function (name) {
    var m = M.mods[name];
    if (!m) throw new Error('Moss: module "' + name + '" is not bundled — add "// @use ' + name + '" to the header.');
    if (!m.module) {
      m.module = { exports: {} };
      m.factory.call(m.module.exports, m.module, m.module.exports, M.require, M.api);
    }
    return m.module.exports;
  };

  var info = { script: ctx.info, scriptHandler: 'Moss', version: ctx.version, sandboxMode: ctx.mode };
  M.api.GM_info = M.GM.info = info;
  M.api.GM_log = M.GM.log = M.log;
  M.api.unsafeWindow = g;
  M.api.GM = M.GM;
  M.api.require = M.require;
  M.api.moss = M.moss = { id: ctx.id, mode: ctx.mode, target: ctx.target, features: ctx.features, log: M.log, ready: null };

  function notBundled(name) {
    return function () {
      throw new Error('Moss: ' + name + ' is not bundled into "' + ctx.info.name + '". Mention it in the script or force the feature in the script options.');
    };
  }

  M.start = function (main) {
    var ready = M.moss.ready = Promise.all(M.waits).catch(M.report);
    function run() {
      try {
        var args = ctx.params.map(function (name) {
          if (ctx.aliases[name]) return M.require(ctx.aliases[name]);
          return name in M.api ? M.api[name] : notBundled(name);
        });
        Promise.resolve(main.apply(g, args)).catch(M.report);
      } catch (e) { M.report(e); }
    }
    function go() { if (ctx.delay) setTimeout(run, ctx.delay); else run(); }
    // Exported background scripts start synchronously so chrome.* listeners are
    // registered on the service worker's first turn (required to be woken by events).
    if (ctx.sync) go(); else ready.then(go);
  };

  return M;
}
MossCore.urlAllowed = function (filter, url) {
  function test(rule) { try { return new RegExp(rule[0], rule[1]).test(url); } catch (e) { return false; } }
  return filter.include.some(test) && !filter.exclude.some(test);
};
