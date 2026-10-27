'use strict';
/*
 * Tampermonkey-compatibility features that DailyScripts rely on: GM APIs in page mode
 * (through the relay), value-change listeners across tabs, GM_openInTab handles, and
 * GM_xmlhttpRequest callbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, build_relay, plan } from '../src/lib/bundler.js';
import { export_extension } from '../src/lib/exporter.js';
import { resolve_settings } from '../src/lib/settings.js';
import { fake_chrome, fs_sources, port_pair, read, run_in_vm, tick } from './helpers.js';

const SETTINGS = resolve_settings({});
const INFO = { id: 'sTest', name: 'Compat', grants: ['GM_xmlhttpRequest'], connect: [] };

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
 * host_with(features, chrome, extra) -> a moss_host serving INFO, with the given host features
 */
function host_with(features, chrome, extra) {
    let code = read('src/shared/host/core.js');
    for (const name of features) {
        code += '\n' + read(`src/shared/host/${name}.js`);
    }
    const ctx = run_in_vm(code, Object.assign({ chrome: chrome }, extra));
    return ctx.moss_host({ icon: 'icon.png', get_script: async function () { return INFO; } });
}

/*
 * port_chrome(host, tab_id) -> a fake chrome whose runtime.connect is served by host
 */
function port_chrome(host, tab_id) {
    return {
        runtime: {
            lastError: undefined,
            connect: function (info) {
                const pair = port_pair(info.name);
                host.attach_port(pair[1], { script_id: 'sTest', tab_id: tab_id });
                return pair[0];
            },
        },
    };
}

/*
 * page_tab(code, relay, host, tab_id) -> the VM context of a page-mode script, with its
 * relay running in a second VM ("world") that shares only the document with it
 */
function page_tab(code, relay, host, tab_id) {
    const doc = new EventTarget();
    const shared = { document: doc, EventTarget: EventTarget, CustomEvent: CustomEvent };
    run_in_vm(relay, Object.assign({ chrome: port_chrome(host, tab_id) }, shared));
    return run_in_vm(code, shared);
}

test('page mode gets GM APIs through the relay: values, listeners across tabs, menus', async function () {
    const code = header(['@name Page', '@match *://*/*', '@sandbox page']) + `
        globalThis.first = GM_getValue('count', 0);
        GM_setValue('count', globalThis.first + 1);
        GM_addValueChangeListener('count', function (key, old_value, new_value, remote) {
            globalThis.heard = [key, old_value, new_value, remote];
        });
        GM_registerMenuCommand('Hi', function () { globalThis.clicked = true; });
    `;
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    assert.equal(p.transport, 'relay');
    assert.equal(p.inject_at, 'document_start', 'injected early so it captures DOM functions first');
    const bundle = await build(p, { sources: fs_sources(), script: s, token: 'secret', settings: SETTINGS });
    const relay = await build_relay(p, { sources: fs_sources(), script: s, token: 'secret' });

    const chrome = fake_chrome([]);
    chrome.store['values:sTest'] = { count: 10 };
    const host = host_with(['values', 'menu'], chrome);

    const tab_a = page_tab(bundle, relay, host, 1);
    await tick(30);
    assert.equal(tab_a.first, 10, 'values arrive through the relay');
    assert.deepEqual(chrome.store['values:sTest'], { count: 11 });

    const tab_b = page_tab(bundle, relay, host, 2);
    await tick(30);
    assert.equal(tab_b.first, 11);
    assert.deepEqual(Array.from(tab_a.heard), ['count', 11, 12, true], 'tab A hears tab B\'s write as remote');

    const menus = host.list_menus(1);
    assert.equal(menus.length, 1);
    host.run_menu(menus[0].conn, menus[0].id);
    await tick();
    assert.equal(tab_a.clicked, true);
});

test('the relay channel name is secret: other page code sees nothing', async function () {
    const code = header(['@name Page', '@match *://*/*', '@sandbox page']) + 'GM_setValue("k", 1);';
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    const bundle = await build(p, { sources: fs_sources(), script: s, token: 'tok-123', settings: SETTINGS });
    assert.ok(!/moss-(up|down)\b/.test(bundle), 'event names are not fixed strings');
    const relay = await build_relay(p, { sources: fs_sources(), script: s, token: 'tok-123' });
    assert.ok(relay.includes('"token":"tok-123"'));
});

test('export of a page-mode script with GM APIs ships the relay as an isolated content script', async function () {
    const code = header(['@name Page', '@match https://a.com/*', '@sandbox page', '@run-at document-idle']) + 'GM_setValue("k", 1);';
    const result = await export_extension({ id: 'sTest', code: code, options: {} }, { sources: fs_sources(), settings: SETTINGS, choices: { include_source: false, include_readme: false } });
    const entries = result.manifest.content_scripts;
    assert.equal(entries.length, 2);
    assert.deepEqual([entries[0].js[0], entries[0].world, entries[0].run_at], ['relay.js', 'ISOLATED', 'document_start']);
    assert.deepEqual([entries[1].js[0], entries[1].world, entries[1].run_at], ['content.js', 'MAIN', 'document_start']);
    assert.deepEqual(result.manifest.permissions, ['storage']);
});

test('GM_openInTab: insert next to the opener, handle.closed + onclose when the tab closes', async function () {
    const code = header(['@name Tabs', '@match *://*/*']) + `
        globalThis.tab = GM_openInTab('https://mail.example/', { active: true, insert: true, setParent: true });
        globalThis.tab.onclose = function () { globalThis.closed_seen = true; };
    `;
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    const calls = [];
    const chrome = fake_chrome(calls);
    const host = host_with(['tabs'], chrome);
    const page = run_in_vm(await build(p, { sources: fs_sources(), script: s, settings: SETTINGS }), { chrome: port_chrome(host, 5) });
    await tick(30);
    let create = null;
    for (const c of calls) {
        if (c[0] === 'tabs.create') {
            create = c[1];
        }
    }
    assert.deepEqual(Object.assign({}, create), { url: 'https://mail.example/', active: true, openerTabId: 5, index: 4, windowId: 1 });
    assert.equal(page.tab.closed, false);

    chrome.tabs.onRemoved.emit(7);
    await tick();
    assert.equal(page.tab.closed, true, 'closed by the user, not by the script');
    assert.equal(page.closed_seen, true);
});

test('GM_xmlhttpRequest: onloadstart, onreadystatechange, onprogress, onload, in that order', async function () {
    const code = header(['@name Xhr', '@match *://*/*', '@grant GM_xmlhttpRequest']) + `
        globalThis.order = [];
        GM_xmlhttpRequest({
            url: 'https://api.example/data', responseType: 'json',
            onloadstart: function () { globalThis.order.push('loadstart'); },
            onreadystatechange: function (r) { globalThis.order.push('readystate ' + r.readyState); },
            onprogress: function (r) { globalThis.order.push('progress ' + r.loaded); },
            onload: function (r) { globalThis.order.push('load ' + r.status + ' ' + r.response.ok); },
            onloadend: function () { globalThis.order.push('loadend'); },
        });
    `;
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    const fake_fetch = async function () {
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const host = host_with(['xhr'], fake_chrome([]), { fetch: fake_fetch, AbortController: AbortController });
    const page = run_in_vm(await build(p, { sources: fs_sources(), script: s, settings: SETTINGS }), { chrome: port_chrome(host, 1) });
    await tick(40);
    assert.deepEqual(Array.from(page.order), ['loadstart', 'readystate 4', 'progress 11', 'load 200 true', 'loadend']);
});

test('document-start scripts start at once from a values snapshot, then take the live values', async function () {
    const code = header(['@name Early', '@match *://*/*', '@run-at document-start']) + `
        globalThis.mode_at_start = GM_getValue('mode', 'full');
        GM_setValue('visits', 1);
    `;
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    assert.equal(p.early, true);
    const bundle = await build(p, { sources: fs_sources(), script: s, settings: SETTINGS, values: { mode: 'lite' } });

    const chrome = fake_chrome([]);
    chrome.store['values:sTest'] = { mode: 'static', other: 'x' };
    const host = host_with(['values'], chrome);
    const page = run_in_vm(bundle, { chrome: port_chrome(host, 1) });
    // No await: the script must already have run, before any round trip to the extension.
    assert.equal(page.mode_at_start, 'lite', 'started synchronously from the snapshot');

    await tick(30);
    assert.deepEqual(chrome.store['values:sTest'], { mode: 'static', other: 'x', visits: 1 }, 'its early write survived the live load');
});

test('scripts that start later still wait for the live values', async function () {
    const code = header(['@name Late', '@match *://*/*']) + 'globalThis.mode_at_start = GM_getValue("mode", "full");';
    const s = { id: 'sTest', code: code, enabled: true, options: {} };
    const p = await plan(s, { sources: fs_sources(), settings: SETTINGS });
    assert.equal(p.early, false);
    const chrome = fake_chrome([]);
    chrome.store['values:sTest'] = { mode: 'static' };
    const page = run_in_vm(await build(p, { sources: fs_sources(), script: s, settings: SETTINGS }), { chrome: port_chrome(host_with(['values'], chrome), 1) });
    assert.equal(page.mode_at_start, undefined);
    await tick(30);
    assert.equal(page.mode_at_start, 'static');
});
