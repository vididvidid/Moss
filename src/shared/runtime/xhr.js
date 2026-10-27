/* Feature: xhr — GM_xmlhttpRequest, performed by the extension so it isn't bound by
   the page's CORS rules. Request bodies: string, URLSearchParams or JSON-able object. */
(function () {
  function bytes(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function body(data) {
    if (data == null || typeof data === 'string') return data;
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return data.toString();
    return JSON.stringify(data);
  }
  function response(r, d) {
    var res = { readyState: 4, status: r.status, statusText: r.statusText, finalUrl: r.finalUrl,
      responseHeaders: r.responseHeaders, responseText: r.responseText, response: r.responseText, context: d.context };
    if (r.base64 != null) {
      var b = bytes(r.base64);
      res.responseText = undefined;
      res.response = d.responseType === 'blob' ? new Blob([b]) : b.buffer;
    } else if (d.responseType === 'json') {
      try { res.response = JSON.parse(r.responseText); } catch (e) { res.response = null; }
    }
    return res;
  }

  function request(d) {
    var aborted = false;
    var req = { method: d.method || 'GET', url: String(d.url), headers: d.headers || {}, data: body(d.data),
      timeout: d.timeout || 0, anonymous: !!d.anonymous,
      binary: d.responseType === 'arraybuffer' || d.responseType === 'blob' };
    var promise = M.call('xhr', [req]).then(function (r) {
      var res = response(r, d);
      if (!aborted) { if (d.onload) d.onload(res); if (d.onloadend) d.onloadend(res); }
      return res;
    }, function (e) {
      var res = { readyState: 4, status: 0, error: e.message, finalUrl: req.url, context: d.context };
      if (!aborted) {
        var cb = /timed out/.test(e.message) && d.ontimeout ? d.ontimeout : d.onerror;
        if (cb) cb(res);
        if (d.onloadend) d.onloadend(res);
      }
      throw e;
    });
    return { promise: promise, abort: function () { aborted = true; if (d.onabort) d.onabort(); } };
  }

  M.api.GM_xmlhttpRequest = function (d) {
    var r = request(d);
    r.promise.catch(function () {});
    return { abort: r.abort };
  };
  M.GM.xmlHttpRequest = function (d) { return request(d).promise; };
})();
