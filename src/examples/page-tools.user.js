// ==UserScript==
// @name         Page tools
// @namespace    moss.examples
// @version      1.1.0
// @description  Reading time, focus mode and quick copy, built from shared modules.
// @folder       Examples
// @match        *://*/*
// @noframes
// @strict
// @use          moss/ui/fab as fab
// @use          moss/ui/toast as toast
// @use          moss/ui/settings as settings
// @use          utils/text as text
// ==/UserScript==

const prefs = settings({
    title: 'Page tools',
    fields: [
        { key: 'wpm', label: 'Reading speed (words per minute)', type: 'number', default: 230 },
        { key: 'focus_width', label: 'Focus mode width (px)', type: 'number', default: 720 },
    ],
});

let focus = null;

/*
 * toggle_focus() — narrow the page to a readable column, or undo it
 */
function toggle_focus() {
    if (focus !== null) {
        focus.remove();
        focus = null;
        return;
    }
    focus = GM_addStyle(`
        body { max-width: ${prefs.get('focus_width')}px !important; margin: 0 auto !important; }
        aside, nav, footer, iframe { opacity: .2 !important; }`);
}

/*
 * show_reading_time() — toast the word count and reading time of the page
 */
function show_reading_time() {
    toast(text.reading_time(document.body.innerText, prefs.get('wpm')));
}

/*
 * copy_link() — put the page title and URL on the clipboard
 */
async function copy_link() {
    await GM_setClipboard(`${document.title}\n${location.href}`);
    toast.success('Copied');
}

fab({
    icon: '✎',
    title: 'Page tools',
    actions: [
        { label: 'Reading time', on_click: show_reading_time },
        { label: 'Focus mode', on_click: toggle_focus },
        { label: 'Copy title + link', on_click: copy_link },
        { label: 'Settings…', on_click: prefs.open },
    ],
});
