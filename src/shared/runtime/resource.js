/*
 * Feature: resource — GM_getResourceText / GM_getResourceURL. Every "@resource name url"
 * file is fetched once when the script is built and bundled in ctx.resources as
 * { url, mime, data } with data in base64, so both calls are synchronous.
 * GM_getResourceURL returns a data: URL (Tampermonkey returns a blob: or data: URL).
 */
(function () {
    'use strict';
    const resources = rt.ctx.resources || {};
    const texts = {};   // name -> decoded text, filled on first use

    /*
     * find(name) -> the bundled resource, or throws a readable error
     */
    function find(name) {
        const res = resources[name];
        if (res === undefined) {
            throw new Error('Moss: no "@resource ' + name + ' <url>" in the header, or it could not be fetched');
        }
        return res;
    }

    /*
     * get_text(name) -> the resource decoded as UTF-8 text
     */
    function get_text(name) {
        if (texts[name] === undefined) {
            const binary = atob(find(name).data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            texts[name] = new TextDecoder().decode(bytes);
        }
        return texts[name];
    }

    /*
     * get_url(name) -> a data: URL holding the resource
     */
    function get_url(name) {
        const res = find(name);
        return 'data:' + res.mime + ';base64,' + res.data;
    }

    /*
     * missing_to_null(fn) -> fn, but returning null instead of throwing (like Tampermonkey)
     */
    function missing_to_null(fn) {
        return function (name) {
            try {
                return fn(name);
            } catch (e) {
                rt.report(e);
                return null;
            }
        };
    }

    rt.api.GM_getResourceText = missing_to_null(get_text);
    rt.api.GM_getResourceURL = missing_to_null(get_url);
    rt.gm.getResourceText = function (name) {
        return Promise.resolve(get_text(name));
    };
    rt.gm.getResourceUrl = function (name) {
        return Promise.resolve(get_url(name));
    };
    rt.gm.getResourceURL = rt.gm.getResourceUrl;
})();
