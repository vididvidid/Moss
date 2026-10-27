/*
 * Feature: clipboard — GM_setClipboard. Local; returns a promise.
 */
(function () {
    'use strict';

    /*
     * legacy_copy(text) — copy through a hidden textarea (works without the Clipboard API)
     */
    function legacy_copy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.documentElement.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) {
            throw new Error('Moss: copying to the clipboard was blocked');
        }
    }

    /*
     * copy(data) -> Promise, resolved once the text is on the clipboard
     */
    function copy(data) {
        const text = String(data);
        let write;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            write = navigator.clipboard.writeText(text);
        } else {
            write = Promise.reject(new Error('no clipboard API'));
        }
        return write.catch(function () {
            legacy_copy(text);
        });
    }

    rt.api.GM_setClipboard = copy;
    rt.gm.setClipboard = copy;
})();
