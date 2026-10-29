# Moss

A modular userscript manager for Chromium (Manifest V3), written from scratch. It runs Tampermonkey and Violentmonkey userscripts as they are, has its own `.moss` script format, and adds three things Tampermonkey doesn't have:

1. **Three sandboxes**: `isolated` (the default), `page` (runs as the page's own JS), and `extension`. An `extension` script has no page and gets real browser APIs such as `chrome.history` and `chrome.browsingData`. That makes things like a DuckDuckGo-style Fire button possible as a userscript (see `fireButton.js` in DailyScripts).
2. **One-click export**: any script becomes a standalone extension (a zip). It contains only the code, permissions and popup that the script actually uses.
3. **Shared modules**: UI and helpers live in modules organised in folders, pulled in with `// @use moss/ui/toast as toast`. Scripts stay short, and the UI isn't rebuilt in every script.

## Install

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. Open Moss's **Details** and turn on **Allow User Scripts**. Chrome requires this for any userscript manager. On Chrome versions before 138, Developer mode alone is enough.
3. Click the Moss icon → **Dashboard**. Two example scripts and one example module are installed, all disabled.

The **On/Off** switch turns every script off at once. It is at the top of the toolbar popup and at the top right of the dashboard. Each script keeps its own Enabled setting, so switching Moss back on restores them as they were. While Moss is off, the toolbar icon shows "off".

A script that has already run keeps running until its page reloads. So switching Moss on or off reloads every open page that one of your scripts runs on: turning Moss off leaves those pages clean, and turning it on starts the scripts there. To reload only the current page, or nothing, change **Settings → General → When Moss is switched on or off**.

The popup lists only the scripts whose `@match` / `@include` rules cover the current page (background scripts show everywhere unless they declare their own `@match`). Switching one script on or off from the popup reloads the page so the change takes effect. To show a "Reload page" button instead, or do nothing, change **Settings → Popup**.

Right-click any page and pick **Open Moss** to bring up the dashboard (an open dashboard tab is reused). It is there even while Moss is off, and Settings → Popup can hide it.

## A script

```js
// ==Moss==
// name:       Hide comments
// match:      https://news.example.com/*
// use:
//   - moss/dom/wait as wait
//   - moss/ui/toast as toast
// ==/Moss==

/*
 * hide(el) — remove one comment section
 */
function hide(el) {
    el.remove();
}

wait.observe('.comments', hide);
toast('Comments hidden');
```

### Two formats: `.moss` and userscripts

Moss reads two kinds of header. They share every key (`name`, `match`, `grant`, `run-at`, `use`, …) and run the same way.

| | `.moss` (Moss's own) | userscript (Tampermonkey / Violentmonkey) |
|---|---|---|
| header | `// ==Moss==` … `// ==/Moss==` | `// ==UserScript==` … `// ==/UserScript==` |
| a key | `// match: https://a.com/*` | `// @match https://a.com/*` |
| several values | repeat the key, or `// match:` followed by `//   - item` lines | repeat the key |
| notes | `// # anything` | — |
| strict mode | on, unless `strict: off` | off, unless `@strict` |
| file | `.moss` | `.user.js` |

- Scripts you make in Moss use `.moss`. Settings → New scripts can switch that to userscripts.
- Userscripts from Greasy Fork, GitHub or a file install unchanged, and keep their header.
- The **⇄** button in the editor rewrites a header in the other format. It keeps every line in order, and the script behaves the same (strict mode included). Use it before sharing a script with someone on Tampermonkey or Violentmonkey.
- Opening a `.moss` or `.user.js` link offers to install it. GitHub repo imports list `.moss` files too. **Download** saves one script as a file, and **Settings → Backup → Download scripts as .zip** saves them all.

The tables below write keys in userscript form (`@match`). In a `.moss` header, drop the `@` and add a colon (`match:`).

| sandbox (`@sandbox`) | runs in | can do |
|---|---|---|
| `isolated` (default) | a private world on the page | DOM, all GM APIs, `moss.chrome` if granted |
| `page` (`none`, `raw`, `JavaScript`, or `@grant none`) | the page's own JS world | patch `window.fetch`, read page globals through `unsafeWindow`, **and** use every GM API (through a relay in the sandbox, over a secret per-script channel) |
| `extension` (`native`, `background`) | background, no page | `@grant chrome.history` → `await moss.chrome.history.search({ text: '' })`, `moss.chrome.history.onVisited.addListener(fn)` |

Other header keys:
- `@match`, `@exclude-match`, `@include`/`@exclude` (globs or `/regex/`), `@run-at` (including `context-menu`, Chrome 135+), `@noframes`
- `@inject-into page|content|auto` (Violentmonkey; same as `@sandbox page` / `isolated`)
- `@updateURL` / `@downloadURL`: a script not imported from a link updates from these when its `@version` goes up
- `@use path [as name]`, `@require url` (fetched once and cached; `#sha256=…` hashes are checked)
- `@resource name url` (fetched once and bundled, for `GM_getResourceText`/`GM_getResourceURL`)
- `@grant` (`GM_xmlhttpRequest`, `GM_download`, `GM_cookie`, `window.close`, `window.focus`, `window.onurlchange`, `chrome.<namespace>`), `@connect`
- `@folder a/b` (place in the sidebar), `@inject raw` or `@unwrap` (no wrapper)
- `@strict` (run the script in strict mode — recommended)

APIs:
- `GM_getValue`/`setValue`/`deleteValue`/`listValues`, `GM_getValues`/`setValues`/`deleteValues`, `GM_addValueChangeListener`/`GM_removeValueChangeListener` (also fires for changes made in another tab)
- `GM_getResourceText`, `GM_getResourceURL`, `GM_getTab`/`saveTab`/`getTabs`, `GM_cookie.list`/`set`/`delete`, `window.onurlchange`
- `GM_audio.setMute`/`getState`/`addStateChangeListener`/`removeStateChangeListener` (mute the script's tab and follow its sound; no permission needed)
- `GM_addStyle`, `GM_addElement`
- `GM_xmlhttpRequest`, `GM_notification`, `GM_download`
- `GM_registerMenuCommand` (commands show in the toolbar popup and the right-click menu)
- `GM_openInTab` (`active`, `insert`, `setParent`; the handle's `closed`/`onclose` follow the real tab), `GM_setClipboard`, `GM_info`
- `GM.*` promise versions, `moss.chrome`, `require()`
- Top-level `await` works.

**Tampermonkey compatibility details**
- **Early start:** a `@run-at document-start` script that uses GM values carries a snapshot of them and starts right away, before the page's own scripts. The live values replace the snapshot a moment later.
- **Manager:** opening a `.user.js` link offers to install it; a global "Never run scripts on these pages" list; deleted scripts go to a trash; the toolbar badge counts scripts running on the tab; a search box over scripts and modules; click a script's dot in the sidebar to switch it on or off; `@icon` shown in the sidebar; import several files at once; download all scripts as a zip; Tampermonkey-style editor shortcuts, customisable in Settings → Editor.
- **Editor:** syntax colouring, and **Format** (Alt+Shift+F) to re-indent and tidy spaces. It never joins or splits lines, and leaves strings, regexes and comments alone. `case` sits at its `switch`'s level, C style. Optional format on save. All in Settings → Editor.
- **`GM_xmlhttpRequest`:** supports `onloadstart`, `onreadystatechange`, `onprogress`, `onload`, `onerror`, `ontimeout`, `onabort` and `onloadend`, with `responseType` `json`, `document`, `arraybuffer` or `blob`.

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
- **Live reload from a local file:** go to Options → Source → **Link a local file…** and pick the file. While a Moss page is open, the script reloads every time you save the file. Extensions can't read `@require file://` URLs, so this is Moss's way to develop against a local copy.

## How it fits together

```
src/shared/features.js    one table: every runtime feature, how to detect it, its permissions
src/shared/runtime/       client side; core.js + one transport-*.js + one file per feature
src/shared/host/          privileged side; core.js + one file per feature (same split)
src/lib/meta.js           header parsing (.moss and userscript), match patterns / globs / regex
src/lib/formats.js        .moss ⇄ userscript conversion, file extensions
src/lib/js_tokens.js      JavaScript tokenizer (editor colours + formatter)
src/lib/js_format.js      the editor's auto-format
src/lib/bundler.js        plan() decides features, modules, permissions; build() assembles the code
src/lib/exporter.js       plan + build → standalone MV3 extension (only what's used)
src/lib/github.js         GitHub/gist/URL links → raw files, repo listings, token handling
src/lib/updater.js        update checks: changed upstream vs edited locally, @version rule
src/lib/settings.js       every option as a schema (the dashboard renders it)
src/modules/moss/ui/      core, button, toast, panel, modal, fab, form, settings (+ index = all)
src/modules/moss/dom/     query, wait, url, util (+ index = all)
src/background.js         registers scripts with chrome.userScripts, runs the API host
src/runner/               offscreen document + sandboxed iframes for extension-mode scripts
src/dashboard/, src/popup/  (dashboard/highlight.js: syntax colouring)
```

**Minimal bundles.** A feature is included only when the script (or a module it uses) mentions its API, has a matching `@grant`, or is forced on in the script's Options tab. Modules that want a feature *only if the script already has it* write `api['GM_getValue']`, in quotes, which isn't detected. A script that only calls `GM_addStyle` exports as `manifest.json` + `content.js`: no background worker, no permissions, no popup. The **Bundle** tab shows exactly what is included and why.

**Options.** There are global settings (Settings tab), per-script overrides (Options tab, so you don't have to edit the header), and per-export choices (features, extras, editable `manifest.json`). Any built-in module can be overridden: open it and click **Override built-in**.

**Adding a feature.**
1. Add a row to `src/shared/features.js`.
2. Add `src/shared/runtime/<name>.js`.
3. If the feature needs extension privileges, add `src/shared/host/<name>.js` and import it in `src/background.js`.

## Strict mode & C-style JavaScript

Moss is written as strict-mode, C-style JavaScript. The rules are in [STYLE.md](STYLE.md):
- `'use strict'` first in every file;
- snake_case names;
- function declarations with a `name(args) -> result` comment;
- plain `for` loops instead of `map`/`filter`;
- braces everywhere;
- no `var`, `?.` or `??`.

`npm test` runs a zero-dependency checker (`tests/style.test.js`) that fails on any violation, with `file:line`.

**Recommended for your scripts too.** Strict mode turns silent mistakes into errors. For example, assigning to a misspelled variable throws instead of quietly creating a global. You can switch it on in three ways:
- add `// @strict` to a script's header (new scripts get it by default);
- set it per script in the Options tab;
- set it for every script in Settings → Runtime.

Moss's own runtime code always runs strict, but it never forces strict mode on your code. That keeps sloppy scripts imported from elsewhere working.

## Development

```sh
npm test         # style checker, bundler, exporter, zip, runtime ↔ host protocol, strict mode, storage migration
npm run check    # syntax-check every file
npm run icons    # regenerate icons/
```

## Limits (v0.2)
- Chromium only. Firefox has no offscreen documents, so `extension` mode would need a different runner.
- An imported script updates from the URL it was imported from. `@updateURL` / `@downloadURL` are used only for scripts without one. `md5` integrity hashes are not checked (Web Crypto has no MD5).
- Not implemented: `GM_webRequest` (deprecated in Tampermonkey too), cloud sync, `@run-in` (incognito / containers), a page whitelist mode.
- `unsafeWindow` in `isolated` mode is the sandbox's own `window`. Use `@sandbox page` for page globals.
- In an exported *background* script, start-up is synchronous, so that `chrome.*` listeners register on the service worker's first turn. Read values with `await GM.getValue(...)` there.
