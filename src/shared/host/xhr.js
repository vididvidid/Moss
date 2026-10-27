/* Host feature: xhr — performs GM_xmlhttpRequest with fetch() from the extension. */
MossHostFeatures.xhr = function (H) {
  function allowed(s, url, conn) {
    if (!s.connect.length) return !H.policy.requireConnect;
    var host = new URL(url).hostname;
    return s.connect.some(function (c) {
      if (c === '*') return true;
      if (c === 'self') c = conn.url ? new URL(conn.url).hostname : '';
      return host === c || host.slice(-(c.length + 1)) === '.' + c;
    });
  }
  function base64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  H.handlers.xhr = async function (c, s, a) {
    var d = a[0];
    H.requireGrant(s, ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'], 'GM_xmlhttpRequest');
    if (!/^https?:/i.test(d.url)) throw new Error('Moss: only http(s) URLs can be requested');
    if (!allowed(s, d.url, c)) throw new Error('Moss: ' + new URL(d.url).hostname + ' is not listed in @connect');
    var ctrl = new AbortController();
    var timer = d.timeout ? setTimeout(function () { ctrl.abort(); }, d.timeout) : null;
    try {
      var res = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data,
        credentials: d.anonymous ? 'omit' : 'include', signal: ctrl.signal });
      var headers = '';
      res.headers.forEach(function (v, k) { headers += k + ': ' + v + '\r\n'; });
      var out = { status: res.status, statusText: res.statusText, finalUrl: res.url, responseHeaders: headers };
      if (d.binary) out.base64 = base64(await res.arrayBuffer()); else out.responseText = await res.text();
      return out;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Moss: request timed out');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
};
