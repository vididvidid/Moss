/* Host feature: values — per-script storage in chrome.storage.local ("values:<id>"). */
MossHostFeatures.values = function (H) {
  var area = chrome.storage.local, queues = {};
  function key(s) { return 'values:' + s.id; }
  // Writes are serialised per script so rapid GM_setValue calls never race.
  function update(s, change) {
    var k = key(s);
    var next = (queues[k] || Promise.resolve()).then(function () {
      return area.get(k).then(function (o) {
        var v = o[k] || {};
        change(v);
        var patch = {};
        patch[k] = v;
        return area.set(patch);
      });
    });
    queues[k] = next.catch(function () {});
    return next;
  }
  H.handlers['values.load'] = function (c, s) {
    return area.get(key(s)).then(function (o) { return o[key(s)] || {}; });
  };
  H.handlers['values.set'] = function (c, s, a) { return update(s, function (v) { v[a[0]] = a[1]; }); };
  H.handlers['values.delete'] = function (c, s, a) { return update(s, function (v) { delete v[a[0]]; }); };
};
