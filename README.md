# Moss

A modular userscript manager for Chromium (Manifest V3), written from scratch. It adds three things Tampermonkey doesn't have:

1. **Three sandboxes**: `isolated` (the default), `page` (runs as the page's own JS), and `extension`. An `extension` script has no page and gets real browser APIs such as `chrome.history` and `chrome.browsingData`. That makes things like a DuckDuckGo-style Fire button possible as a userscript (see `fireButton.js` in DailyScripts).
2. **One-click export**: any script becomes a standalone extension (a zip). It contains only the code, permissions and popup that the script actually uses.
3. **Shared modules**: UI and helpers live in modules organised in folders, pulled in with `// @use moss/ui/toast as toast`. Scripts stay short, and the UI isn't rebuilt in every script.

## Install

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. Open Moss's **Details** and turn on **Allow User Scripts**. Chrome requires this for any userscript manager. On Chrome versions before 138, Developer mode alone is enough.
3. Click the Moss icon → **Dashboard**. Two example scripts and one example module are installed, all disabled.

## A script

```js
// ==UserScript==
// @name         Hide comments
// @match        https://news.example.com/*
// @use          moss/dom/wait as wait
// @use          moss/ui/toast as toast
// ==/UserScript==

wait.observe('.comments', (el) => el.remove());
toast('Comments hidden');
```

| sandbox (`@sandbox`) | runs in | can do |
|---|---|---|
| `isolated` (default) | a private world on the page | DOM, all GM APIs, `moss.chrome` if granted |
| `page` (`none`, `raw`, or `@grant none`) | the page's own JS world | patch `window.fetch`, read page globals; values go to localStorage; no privileged APIs |
| `extension` (`native`, `background`) | background, no page | `@grant chrome.history` → `await moss.chrome.history.search({ text: '' })`, `moss.chrome.history.onVisited.addListener(fn)` |

Other header keys:
- `@match`, `@exclude-match`, `@include`/`@exclude` (globs or `/regex/`), `@run-at`, `@noframes`
- `@use path [as name]`, `@require url` (fetched once and cached)
- `@grant` (`GM_xmlhttpRequest`, `GM_download`, `chrome.<namespace>`), `@connect`
- `@folder a/b` (place in the sidebar), `@inject raw` (no wrapper)

APIs:
- `GM_getValue`/`setValue`/`deleteValue`/`listValues`
- `GM_addStyle`, `GM_addElement`
- `GM_xmlhttpRequest`, `GM_notification`, `GM_download`
- `GM_registerMenuCommand` (commands show in the toolbar popup)
- `GM_openInTab`, `GM_setClipboard`, `GM_info`
- `GM.*` promise versions, `moss.chrome`, `require()`
- Top-level `await` works.

## Import from GitHub and keep scripts updated

**Import…** accepts:
- a GitHub file link (`…/blob/main/script.js`) or a raw link;
- a repository or folder link (you tick which of its userscripts to import);
- a gist;
- any other URL.

Each imported script remembers its source:
- **↻ Update** (toolbar, or Options → Source) fetches the latest version right away, skipping GitHub's ~5-minute cache.
- **Auto-update** (Options → Source) checks every 15 minutes up to every week. Defaults are set in Settings → Updates, along with a **Check all now** button.
- **Your edits are safe.** If you edit a script in Moss, auto-update won't overwrite your edits unless you allow it in Settings, and **↻ Update** asks before replacing them. Optionally, auto-update only when `@version` goes up.
- **Private repos** need a GitHub token in Settings → GitHub. The token is only sent to GitHub hosts.

## How it fits together

```
src/shared/features.js    one table: every runtime feature, how to detect it, its permissions
src/shared/runtime/       client side; core.js + one transport-*.js + one file per feature
src/shared/host/          privileged side; core.js + one file per feature (same split)
src/lib/meta.js           header parsing, match patterns / globs / regex
src/lib/bundler.js        plan() decides features, modules, permissions; build() assembles the code
src/lib/exporter.js       plan + build → standalone MV3 extension (only what's used)
src/lib/github.js         GitHub/gist/URL links → raw files, repo listings, token handling
src/lib/updater.js        update checks: changed upstream vs edited locally, @version rule
src/lib/settings.js       every option as a schema (the dashboard renders it)
src/modules/moss/ui/      core, button, toast, panel, modal, fab, form, settings (+ index = all)
src/modules/moss/dom/     query, wait, url, util (+ index = all)
src/background.js         registers scripts with chrome.userScripts, runs the API host
src/runner/               offscreen document + sandboxed iframes for extension-mode scripts
src/dashboard/, src/popup/
```

**Minimal bundles.** A feature is included only when the script (or a module it uses) mentions its API, has a matching `@grant`, or is forced on in the script's Options tab. Modules that want a feature *only if the script already has it* write `api['GM_getValue']`, in quotes, which isn't detected. A script that only calls `GM_addStyle` exports as `manifest.json` + `content.js`: no background worker, no permissions, no popup. The **Bundle** tab shows exactly what is included and why.

**Options.** There are global settings (Settings tab), per-script overrides (Options tab, so you don't have to edit the header), and per-export choices (features, extras, editable `manifest.json`). Any built-in module can be overridden: open it and click **Override built-in**.

**Adding a feature.**
1. Add a row to `src/shared/features.js`.
2. Add `src/shared/runtime/<name>.js`.
3. If the feature needs extension privileges, add `src/shared/host/<name>.js` and import it in `src/background.js`.

## Development

```sh
npm test         # bundler, exporter, zip, runtime ↔ host protocol, an exported background script run in a VM
npm run check    # syntax-check every file
npm run icons    # regenerate icons/
```

## Limits (v0.1)
- Chromium only. Firefox has no offscreen documents, so `extension` mode would need a different runner.
- `@resource`, `GM_getResourceText` and `GM_addValueChangeListener` are not implemented yet. Updates follow the URL you imported from, not `@updateURL`.
- `unsafeWindow` in `isolated` mode is the sandbox's own `window`. Use `@sandbox page` for page globals.
- In an exported *background* script, start-up is synchronous, so that `chrome.*` listeners register on the service worker's first turn. Read values with `await GM.getValue(...)` there.
