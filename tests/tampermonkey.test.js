'use strict';
/*
 * Tampermonkey parity: @resource, GM_getValues, GM_getTab, GM_cookie, window.close,
 * window.onurlchange, subresource integrity, @run-at context-menu, @unwrap, the global
 * page blacklist, a fuller GM_info and the editor's key map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, plan, with_blocked_pages } from '../src/lib/bundler.js';
import { meta_block, parse_meta, parse_resources, url_matches } from '../src/lib/meta.js';
import { resolve_settings } from '../src/lib/settings.js';
import { check_integrity, sri_hashes } from '../src/lib/sources.js';
import { canon_key, keymap } from '../src/dashboard/editor_keys.js';
import { fake_chrome, fs_sources, port_pair, read, run_in_vm, tick } from './helpers.js';

const SETTINGS = resolve_settings({});

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
 * host_with(features, chrome, info, policy) -> a moss_host serving one script
 */
function host_with(features, chrome, info, policy) {
    let code = read('src/shared/host/core.js');
    for (const name of features) {
        code += '\n' + read(`src/shared/host/${name}.js`);
    }
    const ctx = run_in_vm(code, { chrome: chrome });
    return ctx.moss_host({ icon: 'icon.png', policy: policy || {}, get_script: async function () { return info; } });
}

/*
 * port_chrome(host, tab_id, url) -> a fake chrome whose runtime.connect is served by host
 */
function port_chrome(host, tab_id, url) {
    return {
        runtime: {
            lastError: undefined,
            connect: function (info) {
                const pair = port_pair(info.name);
                host.attach_port(pair[1], { script_id: 'sTest', tab_id: tab_id, url: url });
                return pair[0];
            },
        },
    };
}

/*
 * with_session(chrome) -> chrome plus an in-memory storage.session
 */
function with_session(chrome) {
    const session = {};
    chrome.storage.session = {
        get: async function (key) {
            const out = {};
            if (key in session) {
                out[key] = structuredClone(session[key]);
            }
            return out;
        },
        set: async function (patch) {
            Object.assign(session, structuredClone(patch));
        },
    };
    chrome.session_store = session;
    return chrome;
}

/*
 * names_of(items) -> the name field of each item
 */
function names_of(items) {
    const out = [];
    for (const item of items) {
        out.push(item.name);
    }
    return out;
}

/*
 * bundle(code, sources) -> { s, p, code } for a script built with SETTINGS
 */
async function bundle(code, sources) {
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: sources || fs_sources(), settings: SETTINGS });
    return { s: s, p: p, code: await build(p, { sources: sources || fs_sources(), script: s, settings: SETTINGS }) };
}

test('header: @run-at context-menu, @unwrap, @resource, @tag and the raw header text', function () {
    const code = header(['@name H', '@match *://*/*', '@run-at context-menu', '@unwrap', '@resource css https://cdn.example/a.css',
        '@resource logo https://cdn.example/logo.png', '@tag tools', '@supportURL https://help.example']) + 'x();';
    const meta = parse_meta(code).meta;
    assert.equal(meta.run_at, 'context_menu');
    assert.equal(meta.inject, 'raw');
    assert.deepEqual(parse_resources(meta), [{ name: 'css', url: 'https://cdn.example/a.css' }, { name: 'logo', url: 'https://cdn.example/logo.png' }]);
    assert.deepEqual(meta.tag, ['tools']);
    assert.equal(meta.support_url, 'https://help.example');
    assert.ok(meta_block(code).startsWith('// ==UserScript==') && meta_block(code).endsWith('// ==/UserScript=='));
});

test('@run-at context-menu scripts are planned for the right-click menu, not page load', async function () {
    const built = await bundle(header(['@name Ctx', '@match https://a.example/*', '@run-at context-menu']) + 'x();');
    assert.equal(built.p.context_menu, true);
    assert.deepEqual(built.p.targets.matches, ['https://a.example/*']);
});

test('@resource: GM_getResourceText / GM_getResourceURL read the bundled files', async function () {
    const sources = Object.assign(fs_sources(), {
        resource: async function (url) {
            return { mime: 'text/css', data: Buffer.from(`/* ${url} */ body { color: red }`).toString('base64') };
        },
    });
    const code = header(['@name Res', '@match *://*/*', '@resource style https://cdn.example/s.css']) + `
        globalThis.text = GM_getResourceText('style');
        globalThis.url = GM_getResourceURL('style');
        globalThis.missing = GM_getResourceText('nope');
        globalThis.info = GM_info;
    `;
    const built = await bundle(code, sources);
    assert.ok(names_of(built.p.features).includes('resource'));
    const page = run_in_vm(built.code, { atob: atob, TextDecoder: TextDecoder, console: { log: function () {}, error: function () {} } });
    await tick();
    assert.equal(page.text, '/* https://cdn.example/s.css */ body { color: red }');
    assert.ok(page.url.startsWith('data:text/css;base64,'));
    assert.equal(page.missing, null);
    assert.deepEqual(names_of(page.info.script.resources), ['style']);
    assert.ok(page.info.scriptMetaStr.includes('@resource style'));
    assert.equal(page.info.scriptHandler, 'Moss');
});

test('GM_getValues / GM_setValues / GM_deleteValues', async function () {
    const code = header(['@name Vals', '@match *://*/*']) + `
        globalThis.before = GM_getValues({ a: 1, b: 2 });
        GM_setValues({ a: 10, c: 30 });
        GM_deleteValues(['old']);
        globalThis.after = GM_getValues(['a', 'c', 'old']);
    `;
    const built = await bundle(code);
    const chrome = fake_chrome([]);
    chrome.store['values:sTest'] = { b: 5, old: 'x' };
    const host = host_with(['values'], chrome, { id: 'sTest', name: 'Vals', grants: [], connect: [] });
    const page = run_in_vm(built.code, { chrome: port_chrome(host, 1) });
    await tick(30);
    assert.deepEqual(Object.assign({}, page.before), { a: 1, b: 5 });
    assert.deepEqual(Object.assign({}, page.after), { a: 10, c: 30 });
    assert.deepEqual(chrome.store['values:sTest'], { b: 5, a: 10, c: 30 });
});

test('GM_saveTab / GM_getTab / GM_getTabs keep an object per tab until it closes', async function () {
    const code = header(['@name Tabs', '@match *://*/*']) + `
        GM_saveTab({ seen: true });
        GM_getTab(function (t) { globalThis.mine = t; });
        GM_getTabs(function (all) { globalThis.all = all; });
    `;
    const built = await bundle(code);
    const chrome = with_session(fake_chrome([]));
    const host = host_with(['tab'], chrome, { id: 'sTest', name: 'Tabs', grants: [], connect: [] });
    const page = run_in_vm(built.code, { chrome: port_chrome(host, 9) });
    await tick(40);
    assert.deepEqual(Object.assign({}, page.mine), { seen: true });
    assert.deepEqual(Object.keys(page.all), ['9']);
    chrome.tabs.onRemoved.emit(9);
    await tick(20);
    assert.deepEqual(chrome.session_store.tab_data, { sTest: {} });
});

test('GM_cookie: needs the grant, hides HttpOnly cookies by default, refuses to set them', async function () {
    const code = header(['@name Cookies', '@match *://*/*', '@grant GM_cookie']) + `
        GM_cookie.list({}, function (cookies, error) { globalThis.listed = cookies; globalThis.list_error = error; });
        GM_cookie.set({ name: 'sid', value: '1', httpOnly: true }, function (error) { globalThis.set_error = error; });
    `;
    const built = await bundle(code);
    assert.ok(built.p.host_features.includes('cookie'));
    assert.ok(names_of(built.p.permissions).includes('cookies'));
    const calls = [];
    const chrome = fake_chrome(calls);
    chrome.cookies = {
        getAll: async function (query) {
            calls.push(['cookies.getAll', query]);
            return [{ name: 'a', value: '1', httpOnly: false }, { name: 'secret', value: '2', httpOnly: true }];
        },
        set: async function () {
            calls.push(['cookies.set']);
        },
    };
    const host = host_with(['cookie'], chrome, { id: 'sTest', name: 'Cookies', grants: ['GM_cookie'], connect: [] }, { cookies: 'no_httponly' });
    const page = run_in_vm(built.code, { chrome: port_chrome(host, 1, 'https://site.example/page') });
    await tick(30);
    assert.deepEqual(names_of(page.listed), ['a']);
    assert.equal(page.list_error, undefined);
    assert.match(page.set_error, /HttpOnly/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['cookies.getAll', { url: 'https://site.example/page' }]);

    const ungranted = host_with(['cookie'], chrome, { id: 'sTest', name: 'Cookies', grants: [], connect: [] }, { require_grants: true });
    const page2 = run_in_vm(built.code, { chrome: port_chrome(ungranted, 1, 'https://site.example/') });
    await tick(30);
    assert.match(page2.list_error, /@grant GM_cookie/);
});

test('@grant window.close lets the script close its own tab', async function () {
    const code = header(['@name Closer', '@match *://*/*', '@grant window.close']) + 'window.close();';
    const built = await bundle(code.replace('window.close();', 'globalThis.close();'));
    assert.ok(built.p.host_features.includes('window'));
    const calls = [];
    const host = host_with(['window'], fake_chrome(calls), { id: 'sTest', name: 'Closer', grants: ['window.close'], connect: [] });
    run_in_vm(built.code, { chrome: port_chrome(host, 5) });
    await tick(30);
    assert.deepEqual(calls[calls.length - 1], ['tabs.remove', 5]);
});

test('window.onurlchange fires when a single-page app changes the address', async function () {
    const code = header(['@name Spa', '@match *://*/*', '@grant window.onurlchange']) + `
        globalThis.seen = [];
        window.onurlchange = function (info) { globalThis.seen.push('prop ' + info.url); };
        window.addEventListener('urlchange', function (info) { globalThis.seen.push('event ' + info.url); });
    `;
    const built = await bundle(code.replace(/window\./g, 'globalThis.'));
    const target = new EventTarget();
    const location = { href: 'https://app.example/a' };
    const polls = [];
    const page = run_in_vm(built.code, {
        document: {}, location: location, Event: Event,
        addEventListener: target.addEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target),
        setInterval: function (fn) {
            polls.push(fn);
            return polls.length;
        },
    });
    await tick();
    assert.equal(polls.length, 1, 'polls as a fallback');
    location.href = 'https://app.example/b';
    polls[0]();
    polls[0]();
    assert.deepEqual(Array.from(page.seen), ['prop https://app.example/b', 'event https://app.example/b'], 'once per change');
});

test('subresource integrity: #sha256= hashes in hex or base64 are checked', async function () {
    const bytes = new TextEncoder().encode('var lib = 1;');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Buffer.from(digest).toString('hex');
    const b64 = Buffer.from(digest).toString('base64');
    assert.deepEqual(sri_hashes(`https://cdn.example/lib.js#md5=abc,sha256=${hex}`), [{ algorithm: 'md5', value: 'abc' }, { algorithm: 'sha256', value: hex }]);
    await check_integrity(`https://cdn.example/lib.js#sha256=${hex}`, bytes);
    await check_integrity(`https://cdn.example/lib.js#sha256-${b64}`, bytes);
    await check_integrity('https://cdn.example/lib.js#md5=whatever', bytes);
    await assert.rejects(check_integrity(`https://cdn.example/lib.js#sha256=${'0'.repeat(64)}`, bytes), /does not match its sha256 hash/);
});

test('"Never run scripts on these pages" excludes pages for every script', async function () {
    const settings = resolve_settings({ 'security.blocked_pages': ['*paypal.com/*', 'https://*.bank.example/*'] });
    const meta = parse_meta(header(['@name All', '@match *://*/*']) + 'x();').meta;
    const opt = with_blocked_pages({}, settings);
    assert.equal(url_matches(meta, 'https://www.paypal.com/checkout', opt), false);
    assert.equal(url_matches(meta, 'https://news.example/', opt), true);
    const s = { id: 'sTest', code: header(['@name All', '@match *://*/*']) + 'x();', enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: settings });
    assert.deepEqual(p.targets.exclude_globs, ['*paypal.com/*', 'https://*.bank.example/*']);
});

test('editor key map: Tampermonkey defaults, custom lines, "none" frees a key', function () {
    assert.equal(canon_key('Shift-Ctrl-d'), 'Ctrl-Shift-D');
    assert.equal(canon_key('ctrl+alt+up'), 'Ctrl-Alt-Up');
    assert.equal(canon_key('Ctrl--'), 'Ctrl--');
    const result = keymap(['Ctrl-Shift-K = delete_line', 'Ctrl-R = none', 'nonsense', 'F9 = no_such_command']);
    assert.equal(result.map['Ctrl-Shift-K'], 'delete_line');
    assert.equal(result.map['Ctrl-R'], undefined);
    assert.equal(result.map['Alt-Up'], 'move_line_up');
    assert.deepEqual(result.errors, ['nonsense', 'F9 = no_such_command']);
});
