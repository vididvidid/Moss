/*
 * Host feature: xhr — performs GM_xmlhttpRequest with fetch() from the extension.
 */
moss_host_features.xhr = function (host) {
    'use strict';

    /*
     * allowed(script, url, conn) -> true if @connect (or the policy) lets the script reach url
     */
    function allowed(script, url, conn) {
        if (script.connect.length === 0) {
            return !host.policy.require_connect;
        }
        const hostname = new URL(url).hostname;
        for (const entry of script.connect) {
            let name = entry;
            if (name === '*') {
                return true;
            }
            if (name === 'self') {
                name = conn.url ? new URL(conn.url).hostname : '';
            }
            if (hostname === name || hostname.endsWith('.' + name)) {
                return true;
            }
        }
        return false;
    }

    /*
     * base64(buffer) -> base64 text of an ArrayBuffer
     */
    function base64(buffer) {
        const bytes = new Uint8Array(buffer);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(s);
    }

    host.handlers.xhr = async function (conn, script, args) {
        const d = args[0];
        host.require_grant(script, ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'], 'GM_xmlhttpRequest');
        if (!/^https?:/i.test(d.url)) {
            throw new Error('Moss: only http(s) URLs can be requested');
        }
        if (!allowed(script, d.url, conn)) {
            throw new Error('Moss: ' + new URL(d.url).hostname + ' is not listed in @connect');
        }
        const ctrl = new AbortController();
        const timer = d.timeout ? setTimeout(function () {
            ctrl.abort();
        }, d.timeout) : null;
        try {
            const res = await fetch(d.url, {
                method: d.method, headers: d.headers, body: d.data,
                credentials: d.anonymous ? 'omit' : 'include', signal: ctrl.signal,
            });
            let headers = '';
            for (const [name, value] of res.headers) {
                headers += name + ': ' + value + '\r\n';
            }
            const out = { status: res.status, status_text: res.statusText, final_url: res.url, response_headers: headers };
            if (d.binary) {
                const buffer = await res.arrayBuffer();
                out.size = buffer.byteLength;
                out.base64 = base64(buffer);
            } else {
                out.response_text = await res.text();
                out.size = out.response_text.length;
            }
            return out;
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('Moss: request timed out');
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    };
};
