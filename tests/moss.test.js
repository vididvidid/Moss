import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMeta, targets, urlMatches } from '../src/lib/meta.js';
import { build, plan } from '../src/lib/bundler.js';
import { exportExtension } from '../src/lib/exporter.js';
import { resolveSettings } from '../src/lib/settings.js';
import { zip } from '../src/lib/zip.js';
import { fakeChrome, fsSources, portPair, read, runInVm, tick } from './helpers.js';

const settings = resolveSettings({});
const header = (lines) => `// ==UserScript==\n${lines.map((l) => `// ${l}`).join('\n')}\n// ==/UserScript==\n`;
const script = (code, extra = {}) => ({ id: 'sTest', code, enabled: true, options: {}, ...extra });
const noExtras = { includeSource: false, includeReadme: false };

test('metadata: sandbox aliases, @grant none, @use aliases, errors', () => {
  assert.equal(parseMeta(header(['@name a', '@match *://*/*', '@sandbox native'])).meta.sandbox, 'extension');
  assert.equal(parseMeta(header(['@name a', '@match *://*/*', '@grant none'])).meta.sandbox, 'page');
  const { meta } = parseMeta(header(['@name a', '@match *://*/*', '@use moss/ui as ui', '@use utils/x']));
  assert.deepEqual(meta.use, [{ name: 'moss/ui', alias: 'ui' }, { name: 'utils/x', alias: null }]);
  assert.match(parseMeta(header(['@name a', '@match nope'])).errors.join(), /not a valid match pattern/);
  assert.match(parseMeta('alert(1)').errors.join(), /Missing/);
});

test('url matching: match patterns, globs, regex, excludes', () => {
  const { meta } = parseMeta(header(['@name a', '@match https://*.example.com/*', '@include /^https:\\/\\/foo\\.org\\/a/', '@exclude *logout*']));
  assert.ok(urlMatches(meta, 'https://www.example.com/x'));
  assert.ok(urlMatches(meta, 'https://example.com/'));
  assert.ok(urlMatches(meta, 'https://foo.org/abc'));
  assert.ok(!urlMatches(meta, 'https://foo.org/b'));
  assert.ok(!urlMatches(meta, 'https://example.com/logout'));
  assert.ok(!urlMatches(meta, 'https://notexample.com/'));
  assert.ok(targets(meta).filter, 'regex rules need a runtime filter');
  const simple = parseMeta(header(['@name a', '@match https://a.com/*'])).meta;
  assert.equal(targets(simple).filter, null);
});

test('plan: features are detected from script and modules, with reasons', async () => {
  const code = read('src/examples/page-tools.user.js');
  const p = await plan(script(code), { sources: fsSources({ 'utils/text': read('src/examples/utils-text.js') }), settings });
  assert.deepEqual(p.errors, []);
  const names = p.features.map((f) => f.name).sort();
  assert.deepEqual(names, ['clipboard', 'style', 'values']);
  assert.equal(p.features.find((f) => f.name === 'values').reason, 'used by module moss/ui/settings');
  assert.equal(p.transport, 'port');
  assert.deepEqual(p.modules.map((m) => m.name).sort(),
    ['moss/ui/button', 'moss/ui/core', 'moss/ui/fab', 'moss/ui/form', 'moss/ui/modal', 'moss/ui/settings', 'moss/ui/toast', 'utils/text']);
  assert.ok(!p.modules.some((m) => m.name === 'moss/ui/panel'), 'unused components are not bundled');
});

test('plan: missing modules and feature overrides', async () => {
  const code = header(['@name a', '@match *://*/*', '@use nope/thing']) + 'GM_setValue("a", 1)';
  const p = await plan(script(code), { sources: fsSources(), settings });
  assert.match(p.errors.join(), /Module "nope\/thing" not found/);
  const q = await plan(script(code, { options: { features: { values: 'exclude', menu: 'include' } } }), { sources: fsSources(), settings });
  assert.deepEqual(q.features.map((f) => f.name), ['menu']);
});

test('export: a GM_addStyle-only script ships just manifest + content.js', async () => {
  const code = header(['@name Tiny', '@version 1.2', '@match https://a.com/*']) + 'GM_addStyle("body{color:red}")';
  const { files, manifest } = await exportExtension(script(code), { sources: fsSources(), settings, choices: noExtras });
  assert.deepEqual(files.map((f) => f.path).filter((p) => !p.startsWith('icons/')), ['manifest.json', 'content.js']);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
  const content = files.find((f) => f.path === 'content.js').content;
  assert.ok(!content.includes('chrome.runtime.connect'), 'no transport bundled');
  assert.ok(!content.includes('GM_getValue ='), 'no values feature bundled');
});

test('export: page script with no features has no background', async () => {
  const { files, manifest } = await exportExtension(script(read('src/examples/fetch-logger.user.js')), { sources: fsSources(), settings, choices: noExtras });
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.ok(!files.some((f) => f.path === 'background.js'));
});

test('export: a background script carries only the host files and permissions it needs', async () => {
  const { files, manifest, plan: p } = await exportExtension(script(read('tests/fixtures/background.user.js')), { sources: fsSources(), settings, choices: noExtras });
  assert.deepEqual(p.hostFeatures.sort(), ['menu', 'notify']);
  assert.deepEqual(manifest.permissions.sort(), ['browsingData', 'history', 'notifications']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.action.default_popup, 'popup.html');
  const bg = files.find((f) => f.path === 'background.js').content;
  assert.ok(bg.includes('MossHostFeatures.menu') && bg.includes('MossHostFeatures.notify'));
  assert.ok(!bg.includes('MossHostFeatures.xhr') && !bg.includes('MossHostFeatures.chrome'));
});

test('exported background script runs: listeners register synchronously, menu calls chrome.*', async () => {
  const { files } = await exportExtension(script(read('tests/fixtures/background.user.js')), { sources: fsSources(), settings, choices: noExtras });
  const calls = [];
  const chrome = fakeChrome(calls);
  runInVm(files.find((f) => f.path === 'background.js').content, { chrome });
  assert.equal(chrome.history.onVisited.fns.length, 1, 'onVisited registered on the first turn');

  await tick();
  const msg = (m) => new Promise((r) => chrome.runtime.onMessage.emit(m, { id: 'test' }, r));
  const menus = await msg({ type: 'menu.list', tabId: 3 });
  assert.deepEqual(Array.from(menus, (m) => m.caption), ['Clear last hour']);
  await msg({ type: 'menu.run', conn: menus[0].conn, id: menus[0].id });
  await tick();
  assert.deepEqual(calls.map((c) => c[0]), ['browsingData.remove', 'notifications.create']);
  assert.ok(calls[0][1].since > 0);

  chrome.history.onVisited.emit({ url: 'https://sub.example.com/page' });
  chrome.history.onVisited.emit({ url: 'https://other.org/' });
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'history.deleteUrl').map((c) => c[1].url), ['https://sub.example.com/page']);
});

test('sandboxed script ↔ host over a port: values, grants, chrome proxy, events, menus', async () => {
  const code = header(['@name Bridge', '@match *://*/*', '@grant chrome.history']) + `
    GM_setValue('n', (GM_getValue('n', 0)) + 1);
    globalThis.seen = GM_getValue('n');
    globalThis.search = await moss.chrome.history.search({ text: '' });
    moss.chrome.history.onVisited.addListener((item) => { globalThis.visited = item.url; });
    GM_registerMenuCommand('Hi', () => { globalThis.clicked = true; });
    try { await moss.chrome.browsingData.remove({}, {}); } catch (e) { globalThis.denied = e.message; }
  `;
  const p = await plan(script(code), { sources: fsSources(), settings });
  assert.equal(p.transport, 'port');
  const bundle = await build(p, { sources: fsSources(), script: script(code), token: 'secret', settings });

  const calls = [];
  const hostChrome = fakeChrome(calls);
  hostChrome.store['values:sTest'] = { n: 41 };
  const hostCtx = runInVm(read('src/shared/host/core.js') + ['values', 'chrome', 'menu'].map((f) => read(`src/shared/host/${f}.js`)).join('\n'), { chrome: hostChrome });
  const H = hostCtx.MossHost({ policy: { chromeNamespaces: ['history'] }, getScript: async (c) => (c.token === 'secret'
    ? { id: 'sTest', name: 'Bridge', grants: ['chrome.history'], connect: [] } : null) });

  const pageChrome = { runtime: { connect: ({ name }) => {
    const [client, server] = portPair(name);
    const [, scriptId, token] = name.split(':');
    H.attachPort(server, { scriptId, token, tabId: 5 });
    return client;
  } } };
  const page = runInVm(bundle, { chrome: pageChrome });
  await tick(30);
  assert.equal(page.seen, 42);
  assert.deepEqual(hostChrome.store['values:sTest'], { n: 42 });
  assert.deepEqual(page.search, []);
  assert.match(page.denied, /not enabled|@grant chrome.browsingData/);

  hostChrome.history.onVisited.emit({ url: 'https://x.test/' });
  await tick();
  assert.equal(page.visited, 'https://x.test/');

  const [item] = H.listMenus(5);
  assert.equal(item.caption, 'Hi');
  H.runMenu(item.conn, item.id);
  await tick();
  assert.equal(page.clicked, true);
});

test('wrong token is rejected by the host', async () => {
  const code = header(['@name T', '@match *://*/*']) + 'GM_setValue("x", 1); globalThis.loaded = true;';
  const p = await plan(script(code), { sources: fsSources(), settings });
  const bundle = await build(p, { sources: fsSources(), script: script(code), token: 'forged', settings });
  const hostCtx = runInVm(read('src/shared/host/core.js') + read('src/shared/host/values.js'), { chrome: fakeChrome() });
  const H = hostCtx.MossHost({ getScript: async (c) => (c.token === 'real' ? { id: 'sTest', grants: [], connect: [] } : null) });
  const errors = [];
  const page = runInVm(bundle, {
    console: { ...console, error: (...a) => errors.push(a.join(' ')) },
    chrome: { runtime: { connect: ({ name }) => { const [c, s] = portPair(name); H.attachPort(s, { scriptId: 'sTest', token: 'forged' }); return c; } } },
  });
  await tick(30);
  assert.equal(page.loaded, true, 'script still runs');
  assert.ok(errors.some((e) => /disabled or unknown/.test(e)));
});

test('errors in async menu commands reach the extension', async () => {
  const code = header(['@name Oops', '@match *://*/*']) + `GM_registerMenuCommand('Fail', async () => { throw new Error('boom'); });`;
  const p = await plan(script(code), { sources: fsSources(), settings });
  const bundle = await build(p, { sources: fsSources(), script: script(code), settings });
  const reported = [];
  const hostCtx = runInVm(read('src/shared/host/core.js') + read('src/shared/host/menu.js'), { chrome: fakeChrome() });
  const H = hostCtx.MossHost({ getScript: async () => ({ id: 'sTest', name: 'Oops', grants: [], connect: [] }),
    onError: (s, message) => reported.push([s.name, message]) });
  runInVm(bundle, {
    console: { ...console, error: () => {} },
    chrome: { runtime: { connect: ({ name }) => { const [c, s] = portPair(name); H.attachPort(s, { scriptId: 'sTest', tabId: 1 }); return c; } } },
  });
  await tick(30);
  const [item] = H.listMenus(1);
  H.runMenu(item.conn, item.id);
  await tick(30);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][0], 'Oops');
  assert.match(reported[0][1], /boom/);
});

test('zip output is a valid archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moss-'));
  const file = join(dir, 'x.zip');
  writeFileSync(file, zip([{ path: 'manifest.json', content: '{}' }, { path: 'a/b.txt', content: 'héllo' }]));
  const out = execFileSync('unzip', ['-t', file]).toString();
  assert.match(out, /No errors detected/);
});
