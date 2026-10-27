/*
 * Feature: download — GM_download through the browser's download manager.
 */
(function () {
    'use strict';

    /*
     * download(details) or download(url, name) -> Promise of the download id
     */
    function download(a, b) {
        const details = typeof a === 'string' ? { url: a, name: b } : a;
        const p = rt.call('download', [{ url: String(details.url), name: details.name, saveAs: !!details.saveAs }]);
        p.then(function (id) {
            if (details.onload) {
                details.onload({ id: id });
            }
        }, function (e) {
            if (details.onerror) {
                details.onerror({ error: e.message });
            } else {
                rt.report(e);
            }
        });
        return p;
    }

    rt.api.GM_download = download;
    rt.gm.download = download;
})();
