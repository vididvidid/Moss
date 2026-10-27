/* Feature: download — GM_download through the browser's download manager. */
(function () {
  // GM_download(details) or GM_download(url, name)
  function download(a, b) {
    var d = typeof a === 'string' ? { url: a, name: b } : a;
    var p = M.call('download', [{ url: String(d.url), name: d.name, saveAs: !!d.saveAs }]);
    p.then(function (id) { if (d.onload) d.onload({ id: id }); },
      function (e) { if (d.onerror) d.onerror({ error: e.message }); else M.report(e); });
    return p;
  }
  M.api.GM_download = download;
  M.GM.download = download;
})();
