// ==UserScript==
// @name         Background fixture
// @version      1.0.0
// @description  Extension-mode script used by the tests: menu, notification, chrome.* calls and events.
// @sandbox      extension
// @grant        chrome.browsingData
// @grant        chrome.history
// ==/UserScript==

GM_registerMenuCommand('Clear last hour', async () => {
  await moss.chrome.browsingData.remove({ since: Date.now() - 60 * 60e3 }, { history: true });
  GM_notification({ title: 'Cleared', text: 'Last hour cleared.' });
});

moss.chrome.history.onVisited.addListener((item) => {
  if (new URL(item.url).hostname.endsWith('example.com')) moss.chrome.history.deleteUrl({ url: item.url });
});
