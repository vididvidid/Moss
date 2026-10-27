/* Host feature: download — GM_download via chrome.downloads. */
MossHostFeatures.download = function (H) {
  H.handlers.download = async function (c, s, a) {
    H.requireGrant(s, ['GM_download'], 'GM_download');
    if (!chrome.downloads) throw new Error('Moss: the "downloads" permission is missing — re-save the script to grant it');
    var d = a[0];
    return chrome.downloads.download({ url: d.url, filename: d.name || undefined, saveAs: !!d.saveAs });
  };
};
