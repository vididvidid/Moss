/* Host feature: chrome — generic, grant-checked access to chrome.<namespace>.<member>,
   including event subscriptions forwarded to the script. */
MossHostFeatures.chrome = function (H) {
  var SAFE = /^[A-Za-z][A-Za-z0-9]*$/;

  function resolve(s, path) {
    var parts = String(path).split('.');
    if (parts.length < 2 || !parts.every(function (p) { return SAFE.test(p); })) {
      throw new Error('Moss: invalid chrome API path "' + path + '"');
    }
    var ns = parts[0];
    var allowed = H.policy.chromeNamespaces;
    if (allowed && allowed.indexOf(ns) < 0) throw new Error('Moss: chrome.' + ns + ' is not enabled (Moss Settings → Security)');
    if (s.grants.indexOf('chrome.' + ns) < 0 && s.grants.indexOf('chrome.' + parts[0] + '.' + parts[1]) < 0) {
      throw new Error('Moss: add "// @grant chrome.' + ns + '" to use chrome.' + path);
    }
    var parent = chrome[ns];
    if (!parent) throw new Error('Moss: chrome.' + ns + ' is unavailable — the "' + ns + '" permission is missing. Re-save the script to grant it.');
    for (var i = 1; i < parts.length - 1; i++) {
      parent = parent[parts[i]];
      if (!parent) throw new Error('Moss: chrome.' + path + ' does not exist');
    }
    return { parent: parent, member: parent[parts[parts.length - 1]] };
  }

  H.handlers.chrome = async function (c, s, a) {
    var r = resolve(s, a[0]);
    if (typeof r.member !== 'function') {
      if (r.member === undefined) throw new Error('Moss: chrome.' + a[0] + ' does not exist');
      return r.member; // constants such as chrome.tabs.TAB_ID_NONE
    }
    return r.member.apply(r.parent, a[1] || []);
  };

  H.handlers['chrome.listen'] = function (c, s, a) {
    var ev = resolve(s, a[0]).member, id = a[1];
    if (!ev || typeof ev.addListener !== 'function') throw new Error('Moss: chrome.' + a[0] + ' is not an event');
    if (c.subs.has(id)) c.subs.get(id)();
    var fn = function () { c.send({ push: 'event', id: id, args: [].slice.call(arguments) }); };
    ev.addListener(fn);
    c.subs.set(id, function () { ev.removeListener(fn); });
    return true;
  };
  H.handlers['chrome.unlisten'] = function (c, s, a) {
    var off = c.subs.get(a[0]);
    if (off) { off(); c.subs.delete(a[0]); }
    return true;
  };
};
