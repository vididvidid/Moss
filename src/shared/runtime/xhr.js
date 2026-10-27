/*
 * Feature: xhr — GM_xmlhttpRequest, performed by the extension so it isn't bound by
 * the page's CORS rules. Request bodies: string, URLSearchParams or JSON-able object.
 * The callbacks and response fields follow the Tampermonkey API.
 */
(function () {
    'use strict';

    /*
     * base64_bytes(text) -> Uint8Array decoded from base64
     */
    function base64_bytes(text) {
        const s = atob(text);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) {
            out[i] = s.charCodeAt(i);
        }
        return out;
    }

    /*
     * request_body(data) -> something the extension can send
     */
    function request_body(data) {
        if (data === null || data === undefined || typeof data === 'string') {
            return data;
        }
        if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
            return data.toString();
        }
        return JSON.stringify(data);
    }

    /*
     * to_response(r, details) -> the Tampermonkey-style response object
     */
    function to_response(r, details) {
        const res = {
            readyState: 4, status: r.status, statusText: r.status_text, finalUrl: r.final_url,
            responseHeaders: r.response_headers, responseText: r.response_text,
            response: r.response_text, context: details.context,
        };
        if (r.base64 !== undefined && r.base64 !== null) {
            const bytes = base64_bytes(r.base64);
            res.responseText = undefined;
            res.response = details.responseType === 'blob' ? new Blob([bytes]) : bytes.buffer;
        } else if (details.responseType === 'json') {
            try {
                res.response = JSON.parse(r.response_text);
            } catch (e) {
                res.response = null;
            }
        }
        return res;
    }

    /*
     * request(details) -> { promise, abort }
     */
    function request(details) {
        let aborted = false;
        const req = {
            method: details.method || 'GET',
            url: String(details.url),
            headers: details.headers || {},
            data: request_body(details.data),
            timeout: details.timeout || 0,
            anonymous: !!details.anonymous,
            binary: details.responseType === 'arraybuffer' || details.responseType === 'blob',
        };

        /*
         * on_done(r) -> response, after calling onload/onloadend
         */
        function on_done(r) {
            const res = to_response(r, details);
            if (!aborted) {
                if (details.onload) {
                    details.onload(res);
                }
                if (details.onloadend) {
                    details.onloadend(res);
                }
            }
            return res;
        }

        /*
         * on_fail(error) — call ontimeout/onerror and onloadend, then rethrow
         */
        function on_fail(error) {
            const res = { readyState: 4, status: 0, error: error.message, finalUrl: req.url, context: details.context };
            if (!aborted) {
                const timed_out = /timed out/.test(error.message) && details.ontimeout;
                const callback = timed_out ? details.ontimeout : details.onerror;
                if (callback) {
                    callback(res);
                }
                if (details.onloadend) {
                    details.onloadend(res);
                }
            }
            throw error;
        }

        const promise = rt.call('xhr', [req]).then(on_done, on_fail);
        return {
            promise: promise,
            abort: function () {
                aborted = true;
                if (details.onabort) {
                    details.onabort();
                }
            },
        };
    }

    rt.api.GM_xmlhttpRequest = function (details) {
        const r = request(details);
        r.promise.catch(function () {});
        return { abort: r.abort };
    };
    rt.gm.xmlHttpRequest = function (details) {
        return request(details).promise;
    };
})();
