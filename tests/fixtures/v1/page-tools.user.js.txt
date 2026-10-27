// ==UserScript==
// @name         Page tools
// @namespace    moss.examples
// @version      1.0.0
// @description  Reading time, focus mode and quick copy, built from shared modules.
// @folder       Examples
// @match        *://*/*
// @noframes
// @use          moss/ui/fab as fab
// @use          moss/ui/toast as toast
// @use          moss/ui/settings as settings
// @use          utils/text as text
// ==/UserScript==

const prefs = settings({
  title: 'Page tools',
  fields: [
    { key: 'wpm', label: 'Reading speed (words per minute)', type: 'number', default: 230 },
    { key: 'focusWidth', label: 'Focus mode width (px)', type: 'number', default: 720 },
  ],
});

let focus = null;
function toggleFocus() {
  if (focus) {
    focus.remove();
    focus = null;
    return;
  }
  focus = GM_addStyle(`
    body { max-width: ${prefs.get('focusWidth')}px !important; margin: 0 auto !important; }
    aside, nav, footer, iframe { opacity: .2 !important; }`);
}

fab({
  icon: '✎',
  title: 'Page tools',
  actions: [
    { label: 'Reading time', onClick: () => toast(text.readingTime(document.body.innerText, prefs.get('wpm'))) },
    { label: 'Focus mode', onClick: toggleFocus },
    { label: 'Copy title + link', onClick: () => GM_setClipboard(`${document.title}\n${location.href}`).then(() => toast.success('Copied')) },
    { label: 'Settings…', onClick: prefs.open },
  ],
});
