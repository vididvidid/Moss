// ==UserScript==
// @name         Background fixture
// @version      1.0.0
// @description  Extension-mode script used by the tests: menu, notification, chrome.* calls and events.
// @sandbox      extension
// @strict
// @grant        chrome.browsingData
// @grant        chrome.history
// ==/UserScript==

/*
 * clear_last_hour() — remove the last hour of history and say so
 */
async function clear_last_hour() {
    await moss.chrome.browsingData.remove({ since: Date.now() - 60 * 60e3 }, { history: true });
    GM_notification({ title: 'Cleared', text: 'Last hour cleared.' });
}

/*
 * forget(item) — delete visits to example.com as they happen
 */
function forget(item) {
    if (new URL(item.url).hostname.endsWith('example.com')) {
        moss.chrome.history.deleteUrl({ url: item.url });
    }
}

GM_registerMenuCommand('Clear last hour', clear_last_hour);
moss.chrome.history.onVisited.addListener(forget);
