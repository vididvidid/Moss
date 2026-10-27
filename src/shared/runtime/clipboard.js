/* Feature: clipboard — GM_setClipboard. Local; returns a promise. */
(function () {
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.documentElement.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Moss: copying to the clipboard was blocked');
  }
  function copy(data) {
    var text = String(data);
    var write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard API'));
    return write.catch(function () { legacyCopy(text); });
  }
  M.api.GM_setClipboard = M.GM.setClipboard = copy;
})();
