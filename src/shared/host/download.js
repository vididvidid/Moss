/*
 * Host feature: download — GM_download via chrome.downloads.
 */
moss_host_features.download = function (host) {
    'use strict';

    host.handlers.download = async function (conn, script, args) {
        host.require_grant(script, ['GM_download'], 'GM_download');
        if (!chrome.downloads) {
            throw new Error('Moss: the "downloads" permission is missing — re-save the script to grant it');
        }
        const d = args[0];
        return chrome.downloads.download({ url: d.url, filename: d.name || undefined, saveAs: !!d.saveAs });
    };
};
