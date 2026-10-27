'use strict';
/*
 * Core tests: metadata, planning, bundling, export, the runtime ↔ host protocol,
 * strict mode, and the zip writer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse_meta, targets, url_matches } from '../src/lib/meta.js';
import { build, plan } from '../src/lib/bundler.js';
import { export_extension } from '../src/lib/exporter.js';
import { resolve_settings } from '../src/lib/settings.js';
import { zip } from '../src/lib/zip.js';
import { fake_chrome, fs_sources, port_pair, read, run_in_vm, tick } from './helpers.js';

const SETTINGS = resolve_settings({});
const NO_EXTRAS = { include_source: false, include_readme: false };

/*
 * header(lines) -> a userscript header block holding lines
 */
function header(lines) {
    let out = '// ==UserScript==\n';
    for (const line of lines) {
        out += `// ${line}\n`;
    }
    return out + '// ==/UserScript==\n';
}

/*
 * script(code, extra) -> a struct script for tests
 */
function script(code, extra) {
    return Object.assign({ id: 'sTest', code: code, enabled: true, options: {} }, extra);
}

/*
 * names_of(list) -> .name of each item, as a plain array
 */
function names_of(list) {
    const out = [];
    for (const item of list) {
        out.push(item.name);
    }
    return out;
}

/*
 * paths_of(files) -> paths of the exported files, icons left out
 */
function paths_of(files) {
    const out = [];
    for (const f of files) {
        if (!f.path.startsWith('icons/')) {
            out.push(f.path);
        }
    }
    return out;
}

/*
 * file_content(files, path) -> content of one exported file
 */
function file_content(files, path) {
    for (const f of files) {
        if (f.path === path) {
            return f.content;
        }
    }
    return null;
}

/*
 * connect_to(host, token, tab_id) -> a fake chrome whose runtime.connect talks to host
 */
function connect_to(host, token, tab_id) {
    return {
        runtime: {
            connect: function (info) {
                const pair = port_pair(info.name);
                const parts = info.name.split(':');
                host.attach_port(pair[1], { script_id: parts[1], token: token === undefined ? parts[2] : token, tab_id: tab_id });
                return pair[0];
            },
        },
    };
}

/*
 * load_host(features, chrome) -> the VM context holding moss_host and the given host features
 */
function load_host(features, chrome) {
    let code = read('src/shared/host/core.js');
    for (const name of features) {
        code += '\n' + read(`src/shared/host/${name}.js`);
    }
    return run_in_vm(code, { chrome: chrome });
}

test('metadata: sandbox aliases, @grant none, @use aliases, @strict, errors', function () {
    assert.equal(parse_meta(header(['@name a', '@match *://*/*', '@sandbox native'])).meta.sandbox, 'extension');
    assert.equal(parse_meta(header(['@name a', '@match *://*/*', '@grant none'])).meta.sandbox, 'page');
    const meta = parse_meta(header(['@name a', '@match *://*/*', '@use moss/ui as ui', '@use utils/x', '@strict'])).meta;
    assert.deepEqual(meta.use, [{ name: 'moss/ui', alias: 'ui' }, { name: 'utils/x', alias: null }]);
    assert.equal(meta.strict, true);
    assert.equal(parse_meta(header(['@name a', '@match *://*/*'])).meta.strict, false);
    assert.match(parse_meta(header(['@name a', '@match nope'])).errors.join(), /not a valid match pattern/);
    assert.match(parse_meta('alert(1)').errors.join(), /Missing/);
});

test('url matching: match patterns, globs, regex, excludes', function () {
    const meta = parse_meta(header(['@name a', '@match https://*.example.com/*', '@include /^https:\\/\\/foo\\.org\\/a/', '@exclude *logout*'])).meta;
    assert.ok(url_matches(meta, 'https://www.example.com/x'));
    assert.ok(url_matches(meta, 'https://example.com/'));
    assert.ok(url_matches(meta, 'https://foo.org/abc'));
    assert.ok(!url_matches(meta, 'https://foo.org/b'));
    assert.ok(!url_matches(meta, 'https://example.com/logout'));
    assert.ok(!url_matches(meta, 'https://notexample.com/'));
    assert.ok(targets(meta).filter, 'regex rules need a runtime filter');
    const simple = parse_meta(header(['@name a', '@match https://a.com/*'])).meta;
    assert.equal(targets(simple).filter, null);
});

test('plan: features are detected from script and modules, with reasons', async function () {
    const code = read('src/examples/page-tools.user.js');
    const p = await plan(script(code), { sources: fs_sources({ 'utils/text': read('src/examples/utils-text.js') }), settings: SETTINGS });
    assert.deepEqual(p.errors, []);
    assert.deepEqual(names_of(p.features).sort(), ['clipboard', 'style', 'values']);
    let reason = null;
    for (const f of p.features) {
        if (f.name === 'values') {
            reason = f.reason;
        }
    }
    assert.equal(reason, 'used by module moss/ui/settings');
    assert.equal(p.transport, 'port');
    assert.equal(p.strict, true);
    assert.deepEqual(names_of(p.modules).sort(),
        ['moss/ui/button', 'moss/ui/core', 'moss/ui/fab', 'moss/ui/form', 'moss/ui/modal', 'moss/ui/settings', 'moss/ui/toast', 'utils/text']);
    assert.ok(!names_of(p.modules).includes('moss/ui/panel'), 'unused components are not bundled');
});

test('plan: missing modules and feature overrides', async function () {
    const code = header(['@name a', '@match *://*/*', '@use nope/thing']) + 'GM_setValue("a", 1)';
    const p = await plan(script(code), { sources: fs_sources(), settings: SETTINGS });
    assert.match(p.errors.join(), /Module "nope\/thing" not found/);
    const q = await plan(script(code, { options: { features: { values: 'exclude', menu: 'include' } } }), { sources: fs_sources(), settings: SETTINGS });
    assert.deepEqual(names_of(q.features), ['menu']);
});

test('strict mode: only for scripts that ask, and Moss itself is always strict', async function () {
    const sloppy_code = 'undeclared_global = 1; globalThis.ran = true;';

    /*
     * run_script(lines, options, settings) -> VM context after running the bundle
     */
    async function run_script(lines, options, settings) {
        const s = script(header(['@name S', '@match *://*/*'].concat(lines)) + sloppy_code, { options: options || {} });
        const p = await plan(s, { sources: fs_sources(), settings: settings || SETTINGS });
        const errors = [];
        const ctx = run_in_vm(await build(p, { sources: fs_sources(), script: s, settings: SETTINGS }), {
            console: Object.assign({}, console, {
                error: function () {
                    errors.push(Array.prototype.slice.call(arguments).join(' '));
                },
            }),
        });
        await tick(20);
        ctx.errors = errors;
        return ctx;
    }

    const sloppy = await run_script([]);
    assert.equal(sloppy.ran, true, 'sloppy scripts still run sloppy');
    assert.equal(sloppy.undeclared_global, 1);

    const strict = await run_script(['@strict']);
    assert.equal(strict.ran, undefined);
    assert.match(strict.errors.join(), /ReferenceError: undeclared_global is not defined/);

    assert.equal((await run_script([], { strict: 'yes' })).ran, undefined, 'per-script option turns it on');
    assert.equal((await run_script(['@strict'], { strict: 'no' })).ran, true, 'per-script option turns it off');
    assert.equal((await run_script([], {}, resolve_settings({ 'runtime.strict_default': true }))).ran, undefined, 'global default');

    // Moss's own functions run strict even though the bundle around the user's code is sloppy.
    // V8 refuses to read .caller of a strict-mode function, so that is the probe.
    const s = script(header(['@name S', '@match *://*/*']) + 'GM_setValue("k", 1); globalThis.api_set = GM_setValue; globalThis.user_fn = function () {};');
    const p = await plan(s, { sources: fs_sources(), settings: resolve_settings({ 'runtime.values_backend': 'local' }) });
    const ctx = run_in_vm(await build(p, { sources: fs_sources(), script: s, settings: SETTINGS }), {
        localStorage: { length: 0, key: function () { return null; }, setItem: function () {}, getItem: function () { return null; } },
    });
    await tick(20);
    assert.equal(ctx.moss_core, undefined, 'moss_core stays inside the bundle');
    assert.throws(function () { return ctx.api_set.caller; }, { name: 'TypeError' }, 'GM_setValue (a runtime feature) is strict');
    assert.doesNotThrow(function () { return ctx.user_fn.caller; }, 'the user\'s own functions stay sloppy');
});

test('export: a GM_addStyle-only script ships just manifest + content.js', async function () {
    const code = header(['@name Tiny', '@version 1.2', '@match https://a.com/*']) + 'GM_addStyle("body{color:red}")';
    const result = await export_extension(script(code), { sources: fs_sources(), settings: SETTINGS, choices: NO_EXTRAS });
    assert.deepEqual(paths_of(result.files), ['manifest.json', 'content.js']);
    assert.equal(result.manifest.background, undefined);
    assert.equal(result.manifest.permissions, undefined);
    assert.equal(result.manifest.action.default_popup, undefined);
    assert.equal(result.manifest.content_scripts[0].world, 'ISOLATED');
    const content = file_content(result.files, 'content.js');
    assert.ok(!content.includes('chrome.runtime.connect'), 'no transport bundled');
    assert.ok(!content.includes('GM_getValue ='), 'no values feature bundled');
});

test('export: page script with no features has no background', async function () {
    const result = await export_extension(script(read('src/examples/fetch-logger.user.js')), { sources: fs_sources(), settings: SETTINGS, choices: NO_EXTRAS });
    assert.equal(result.manifest.content_scripts[0].world, 'MAIN');
    assert.equal(result.manifest.content_scripts[0].run_at, 'document_start');
    assert.equal(file_content(result.files, 'background.js'), null);
});

test('export: a background script carries only the host files and permissions it needs', async function () {
    const result = await export_extension(script(read('tests/fixtures/background.user.js')), { sources: fs_sources(), settings: SETTINGS, choices: NO_EXTRAS });
    assert.deepEqual(result.plan.host_features.slice().sort(), ['menu', 'notify']);
    assert.deepEqual(result.manifest.permissions.slice().sort(), ['browsingData', 'history', 'notifications']);
    assert.equal(result.manifest.content_scripts, undefined);
    assert.equal(result.manifest.action.default_popup, 'popup.html');
    assert.equal(file_content(result.files, 'popup.js'), read('src/export/popup.js'));
    const bg = file_content(result.files, 'background.js');
    assert.ok(bg.includes('moss_host_features.menu') && bg.includes('moss_host_features.notify'));
    assert.ok(!bg.includes('moss_host_features.xhr') && !bg.includes('moss_host_features.chrome'));
});

test('exported background script runs: listeners register synchronously, menu calls chrome.*', async function () {
    const result = await export_extension(script(read('tests/fixtures/background.user.js')), { sources: fs_sources(), settings: SETTINGS, choices: NO_EXTRAS });
    const calls = [];
    const chrome = fake_chrome(calls);
    run_in_vm(file_content(result.files, 'background.js'), { chrome: chrome });
    assert.equal(chrome.history.onVisited.fns.length, 1, 'onVisited registered on the first turn');

    await tick();

    /*
     * message(msg) -> what the background answers to a popup message
     */
    function message(msg) {
        return new Promise(function (resolve) {
            chrome.runtime.onMessage.emit(msg, { id: 'test' }, resolve);
        });
    }
    const menus = await message({ type: 'menu.list', tab_id: 3 });
    assert.deepEqual(Array.from(menus, function (m) { return m.caption; }), ['Clear last hour']);
    await message({ type: 'menu.run', conn: menus[0].conn, id: menus[0].id });
    await tick();
    assert.deepEqual(Array.from(calls, function (c) { return c[0]; }), ['browsingData.remove', 'notifications.create']);
    assert.ok(calls[0][1].since > 0);

    chrome.history.onVisited.emit({ url: 'https://sub.example.com/page' });
    chrome.history.onVisited.emit({ url: 'https://other.org/' });
    await tick();
    const deleted = [];
    for (const c of calls) {
        if (c[0] === 'history.deleteUrl') {
            deleted.push(c[1].url);
        }
    }
    assert.deepEqual(deleted, ['https://sub.example.com/page']);
});

test('sandboxed script ↔ host over a port: values, grants, chrome proxy, events, menus', async function () {
    const code = header(['@name Bridge', '@match *://*/*', '@grant chrome.history']) + `
        GM_setValue('n', (GM_getValue('n', 0)) + 1);
        globalThis.seen = GM_getValue('n');
        globalThis.search = await moss.chrome.history.search({ text: '' });
        moss.chrome.history.onVisited.addListener(function (item) { globalThis.visited = item.url; });
        GM_registerMenuCommand('Hi', function () { globalThis.clicked = true; });
        try { await moss.chrome.browsingData.remove({}, {}); } catch (e) { globalThis.denied = e.message; }
    `;
    const p = await plan(script(code), { sources: fs_sources(), settings: SETTINGS });
    assert.equal(p.transport, 'port');
    const bundle = await build(p, { sources: fs_sources(), script: script(code), token: 'secret', settings: SETTINGS });

    const host_chrome = fake_chrome([]);
    host_chrome.store['values:sTest'] = { n: 41 };
    const host_ctx = load_host(['values', 'chrome', 'menu'], host_chrome);
    const host = host_ctx.moss_host({
        policy: { chrome_namespaces: ['history'] },
        get_script: async function (conn) {
            return conn.token === 'secret' ? { id: 'sTest', name: 'Bridge', grants: ['chrome.history'], connect: [] } : null;
        },
    });

    const page = run_in_vm(bundle, { chrome: connect_to(host, undefined, 5) });
    await tick(30);
    assert.equal(page.seen, 42);
    assert.deepEqual(host_chrome.store['values:sTest'], { n: 42 });
    assert.deepEqual(Array.from(page.search), []);
    assert.match(page.denied, /not enabled|@grant chrome.browsingData/);

    host_chrome.history.onVisited.emit({ url: 'https://x.test/' });
    await tick();
    assert.equal(page.visited, 'https://x.test/');

    const item = host.list_menus(5)[0];
    assert.equal(item.caption, 'Hi');
    host.run_menu(item.conn, item.id);
    await tick();
    assert.equal(page.clicked, true);
});

test('wrong token is rejected by the host', async function () {
    const code = header(['@name T', '@match *://*/*']) + 'GM_setValue("x", 1); globalThis.loaded = true;';
    const p = await plan(script(code), { sources: fs_sources(), settings: SETTINGS });
    const bundle = await build(p, { sources: fs_sources(), script: script(code), token: 'forged', settings: SETTINGS });
    const host = load_host(['values'], fake_chrome([])).moss_host({
        get_script: async function (conn) {
            return conn.token === 'real' ? { id: 'sTest', grants: [], connect: [] } : null;
        },
    });
    const errors = [];
    const page = run_in_vm(bundle, {
        console: Object.assign({}, console, {
            error: function () {
                errors.push(Array.prototype.slice.call(arguments).join(' '));
            },
        }),
        chrome: connect_to(host, 'forged', null),
    });
    await tick(30);
    assert.equal(page.loaded, true, 'script still runs');
    let rejected = false;
    for (const e of errors) {
        if (/disabled or unknown/.test(e)) {
            rejected = true;
        }
    }
    assert.ok(rejected);
});

test('errors in async menu commands reach the extension', async function () {
    const code = header(['@name Oops', '@match *://*/*']) + 'GM_registerMenuCommand(\'Fail\', async function () { throw new Error(\'boom\'); });';
    const p = await plan(script(code), { sources: fs_sources(), settings: SETTINGS });
    const bundle = await build(p, { sources: fs_sources(), script: script(code), settings: SETTINGS });
    const reported = [];
    const host = load_host(['menu'], fake_chrome([])).moss_host({
        get_script: async function () {
            return { id: 'sTest', name: 'Oops', grants: [], connect: [] };
        },
        on_error: function (s, message) {
            reported.push([s.name, message]);
        },
    });
    run_in_vm(bundle, { console: Object.assign({}, console, { error: function () {} }), chrome: connect_to(host, undefined, 1) });
    await tick(30);
    const item = host.list_menus(1)[0];
    host.run_menu(item.conn, item.id);
    await tick(30);
    assert.equal(reported.length, 1);
    assert.equal(reported[0][0], 'Oops');
    assert.match(reported[0][1], /boom/);
});

test('zip output is a valid archive', function () {
    const dir = mkdtempSync(join(tmpdir(), 'moss-'));
    const file = join(dir, 'x.zip');
    writeFileSync(file, zip([{ path: 'manifest.json', content: '{}' }, { path: 'a/b.txt', content: 'héllo' }]));
    const out = execFileSync('unzip', ['-t', file]).toString();
    assert.match(out, /No errors detected/);
});
