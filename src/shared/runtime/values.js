/* Feature: values — GM_getValue & friends. Values are preloaded before the script
   starts so the synchronous API works. Without an extension bridge (page mode) they
   live in the page's localStorage under "moss:<script id>:". */
(function () {
  var api = M.api, GM = M.GM, values = {};
  var bridged = !!M.transport && M.ctx.valuesBackend !== 'local';
  var prefix = 'moss:' + M.ctx.id + ':';
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  var loaded;
  if (bridged) {
    loaded = M.call('values.load').then(function (v) { values = v || {}; });
  } else {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(prefix) === 0) values[k.slice(prefix.length)] = JSON.parse(localStorage.getItem(k));
      }
    } catch (e) { /* no localStorage here */ }
    loaded = Promise.resolve();
  }
  M.waits.push(loaded);

  function persist(key, value) {
    if (bridged) {
      return M.call(value === undefined ? 'values.delete' : 'values.set', value === undefined ? [key] : [key, value]);
    }
    try {
      if (value === undefined) localStorage.removeItem(prefix + key);
      else localStorage.setItem(prefix + key, JSON.stringify(value));
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  }

  api.GM_getValue = function (key, def) {
    return Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : def;
  };
  api.GM_setValue = function (key, value) {
    values[key] = clone(value);
    persist(key, values[key]).catch(M.report);
  };
  api.GM_deleteValue = function (key) {
    delete values[key];
    persist(key, undefined).catch(M.report);
  };
  api.GM_listValues = function () { return Object.keys(values); };

  GM.getValue = function (key, def) { return loaded.then(function () { return api.GM_getValue(key, def); }); };
  GM.setValue = function (key, value) { values[key] = clone(value); return persist(key, values[key]); };
  GM.deleteValue = function (key) { delete values[key]; return persist(key, undefined); };
  GM.listValues = function () { return loaded.then(api.GM_listValues); };
})();
