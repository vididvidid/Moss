'use strict';
/*
 * Tests for the .moss format, header conversion, the editor's tokenizer and
 * auto-formatter, updates from @updateURL / @downloadURL, and GM_audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { build, plan } from '../src/lib/bundler.js';
import { convert_format, file_extension, is_script_file, script_format } from '../src/lib/formats.js';
import { format_js } from '../src/lib/js_format.js';
import { tokenize } from '../src/lib/js_tokens.js';
import { MISSING_HEADER, meta_block, parse_meta } from '../src/lib/meta.js';
import { resolve_settings } from '../src/lib/settings.js';
import { apply_update, check_for_update, header_source } from '../src/lib/updater.js';
import { fake_chrome, fs_sources, port_pair, read, run_in_vm, tick } from './helpers.js';

const SETTINGS = resolve_settings({});

const MOSS = `// ==Moss==
// name:      Hide comments
// version:   1.2.0
// match:
//   - https://news.example.com/*
//   - *://*/*
// # a note, ignored
// use:       moss/ui/toast as toast
// noframes:
// ==/Moss==
toast('hi');
`;

/*
 * script(code) -> a struct script for tests
 */
function script(code) {
    return { id: 'sTest', code: code, enabled: true, options: {}, source: null };
}

/*
 * server(files) -> a fake fetch serving the url → body map
 */
function server(files) {
    return async function (url) {
        const key = url.replace(/[?&]moss=\d+/, '');
        if (!(key in files)) {
            return { ok: false, status: 404, text: async function () { return ''; } };
        }
        return { ok: true, status: 200, text: async function () { return files[key]; } };
    };
}

test('.moss header: key: value lines, "- item" lists, strict by default', function () {
    const parsed = parse_meta(MOSS);
    assert.deepEqual(parsed.errors, []);
    const m = parsed.meta;
    assert.equal(m.format, 'moss');
    assert.equal(m.name, 'Hide comments');
    assert.equal(m.version, '1.2.0');
    assert.deepEqual(m.match, ['https://news.example.com/*', '*://*/*']);
    assert.deepEqual(m.use, [{ name: 'moss/ui/toast', alias: 'toast' }]);
    assert.equal(m.noframes, true);
    assert.equal(m.strict, true, '.moss scripts are strict unless they say otherwise');
    assert.equal(parse_meta(MOSS.replace('// noframes:', '// strict: off')).meta.strict, false);
    assert.ok(meta_block(MOSS).startsWith('// ==Moss==') && meta_block(MOSS).endsWith('// ==/Moss=='));
    assert.equal(script_format(MOSS), 'moss');
    assert.deepEqual(parse_meta('no header').errors, [MISSING_HEADER]);
});

test('userscripts keep working unchanged; Violentmonkey @inject-into is understood', function () {
    const us = '// ==UserScript==\n// @name A\n// @match *://*/*\n// @inject-into page\n// ==/UserScript==\n';
    const m = parse_meta(us).meta;
    assert.equal(m.format, 'userscript');
    assert.equal(m.sandbox, 'page');
    assert.equal(m.strict, false);
    assert.equal(parse_meta(us.replace('page', 'content')).meta.sandbox, 'isolated');
    assert.equal(script_format(us), 'userscript');
});

test('converting between .moss and userscript keeps every key and the behaviour', function () {
    const us = convert_format(MOSS, 'userscript');
    assert.ok(us.startsWith('// ==UserScript==\n// @name         Hide comments\n'));
    assert.ok(us.includes('// @match        https://news.example.com/*\n// @match        *://*/*\n'));
    assert.ok(us.includes('// @strict\n'), 'a .moss script was strict, so the userscript says @strict');
    assert.ok(us.endsWith("// ==/UserScript==\ntoast('hi');\n"), 'the code after the header is untouched');
    const a = parse_meta(MOSS).meta;
    const b = parse_meta(us).meta;
    for (const key of ['name', 'version', 'match', 'use', 'noframes', 'strict']) {
        assert.deepEqual(b[key], a[key], key);
    }
    const back = convert_format(us, 'moss');
    assert.equal(parse_meta(back).meta.format, 'moss');
    assert.deepEqual(parse_meta(back).meta.match, a.match);
    assert.equal(parse_meta(back).meta.strict, true);

    // A sloppy userscript stays sloppy as .moss.
    const sloppy = '// ==UserScript==\n// @name S\n// ==/UserScript==\nx = 1;\n';
    assert.equal(parse_meta(convert_format(sloppy, 'moss')).meta.strict, false);
    assert.equal(convert_format(sloppy, 'userscript'), sloppy);
    assert.throws(function () { convert_format('x = 1;', 'moss'); }, /no header/);
});

test('file names: .moss and .user.js both install', function () {
    assert.equal(file_extension('moss'), '.moss');
    assert.equal(file_extension('userscript'), '.user.js');
    assert.ok(is_script_file('https://x.test/a.moss'));
    assert.ok(is_script_file('a.user.js?x=1'));
    assert.ok(!is_script_file('a.js'));
});

test('a .moss script bundles strict with a .moss sourceURL', async function () {
    const p = await plan(script(MOSS), { sources: fs_sources(), settings: SETTINGS });
    assert.deepEqual(p.errors, []);
    assert.equal(p.strict, true);
    const code = await build(p, { sources: fs_sources(), script: script(MOSS), settings: SETTINGS });
    assert.ok(code.endsWith('//# sourceURL=moss/hide-comments.moss'));
});

test('tokenizer: tokens join back to the exact source, regex vs division', function () {
    const files = execSync('git ls-files "src/*.js"', { cwd: new URL('../', import.meta.url) }).toString().trim().split('\n');
    for (const file of files) {
        const src = read(file);
        let joined = '';
        for (const tok of tokenize(src)) {
            joined += tok.text;
        }
        assert.equal(joined, src, file);
    }
    const types = [];
    for (const tok of tokenize('a = b / c; r = /x[/]y/g; `t${ {a: `n`}.a }`')) {
        if (tok.type !== 'space') {
            types.push(tok.type);
        }
    }
    assert.deepEqual(types, ['word', 'punct', 'word', 'punct', 'word', 'punct', 'word', 'punct', 'regex', 'punct', 'template']);
});

test('auto-format: re-indents and tidies spaces, never joins lines, is idempotent', function () {
    const messy = [
        'function* gen(){yield* other();}',
        'const   a=b+-c, d = e?f:g;',
        'if(a&&b){',
        'x=y*2/3',
        '}else{',
        '  switch(k){',
        '      case 1:',
        '   foo( 1 ,2 );',
        '   break;',
        '      default: {',
        '   bar();',
        '   }',
        '  }',
        '}',
        '',
        '',
        '',
        'promise.then(function(v){',
        'log(v)',
        '}).catch (function(e){ log(e) });',
        'const s = `keep',
        '   this ${ a+b }`;',
        'items.filter(x=>x>1)',
        '.map(x => x*2);   ',
    ].join('\n');
    const want = [
        'function* gen() { yield* other(); }',
        'const a = b + -c, d = e ? f : g;',
        'if (a && b) {',
        '    x = y * 2 / 3',
        '} else {',
        '    switch (k) {',
        '    case 1:',
        '        foo(1, 2);',
        '        break;',
        '    default: {',
        '        bar();',
        '    }',
        '    }',
        '}',
        '',
        'promise.then(function (v) {',
        '    log(v)',
        '}).catch(function (e) { log(e) });',
        'const s = `keep',
        '   this ${ a+b }`;',
        'items.filter(x => x > 1)',
        '    .map(x => x * 2);',
        '',
    ].join('\n');
    const out = format_js(messy);
    assert.equal(out, want);
    assert.equal(format_js(out), out);
    assert.equal(format_js('if(x){\ny()\n}\n', { indent: '\t', spacing: false }), 'if(x){\n\ty()\n}\n');
    // Moss's own sources are already formatted.
    for (const file of ['src/lib/meta.js', 'src/background.js', 'src/lib/js_format.js']) {
        assert.equal(format_js(read(file)), read(file), file);
    }
});

test('updates from @updateURL / @downloadURL: only a higher @version installs', async function () {
    const mine = '// ==UserScript==\n// @name U\n// @version 1.0\n// @updateURL https://x.test/u.meta.js\n// ==/UserScript==\nold();\n';
    const meta2 = '// ==UserScript==\n// @name U\n// @version 1.1\n// ==/UserScript==\n';
    const code2 = '// ==UserScript==\n// @name U\n// @version 1.1\n// @updateURL https://x.test/u.meta.js\n// ==/UserScript==\nnew_code();\n';
    const s = script(mine);
    const src = header_source(s, SETTINGS);
    assert.equal(src.url, 'https://x.test/u.user.js', 'no @downloadURL: the .meta.js URL ending in .user.js');
    assert.equal(src.from_header, true);
    assert.equal(header_source(s, resolve_settings({ 'update.header_urls': false })), null);
    assert.equal(header_source(Object.assign({}, s, { source: { url: 'https://y.test/a.js' } }), SETTINGS), null);

    const fetch_impl = server({ 'https://x.test/u.meta.js': meta2, 'https://x.test/u.user.js': code2 });
    const check = await check_for_update(s, { settings: SETTINGS, fetch_impl: fetch_impl });
    assert.equal(check.status, 'update');
    assert.equal(check.version, '1.1');
    const updated = apply_update(s, check);
    assert.equal(updated.code, code2);
    assert.equal(updated.source, null, 'it keeps updating from its header');

    const same = await check_for_update(script(code2), { settings: SETTINGS, fetch_impl: fetch_impl });
    assert.equal(same.status, 'current');
});

test('GM_audio: mute the script\'s tab, read its state, follow changes', async function () {
    const code = '// ==UserScript==\n// @name Audio\n// @match *://*/*\n// ==/UserScript==\n'
        + 'GM_audio.addStateChangeListener(function (c) { globalThis.change = c; });\n'
        + 'await GM.audio.setMute({ isMuted: true });\n'
        + 'globalThis.state = await GM.audio.getState();\n';
    const p = await plan(script(code), { sources: fs_sources(), settings: SETTINGS });
    assert.ok(p.host_features.includes('audio'));
    assert.deepEqual(p.permissions, [], 'no permission needed');
    const bundle = await build(p, { sources: fs_sources(), script: script(code), token: 't', settings: SETTINGS });

    const calls = [];
    const chrome = fake_chrome(calls);
    const listeners = [];
    chrome.tabs.update = async function (id, props) {
        calls.push(['tabs.update', id, props]);
        return { id: id };
    };
    chrome.tabs.get = async function (id) {
        return { id: id, audible: true, mutedInfo: { muted: true, reason: 'extension' } };
    };
    chrome.tabs.onUpdated = {
        addListener: function (fn) { listeners.push(fn); },
        removeListener: function () {},
    };
    const code_host = read('src/shared/host/core.js') + '\n' + read('src/shared/host/audio.js');
    const host = run_in_vm(code_host, { chrome: chrome }).moss_host({
        get_script: async function () {
            return { id: 'sTest', name: 'Audio', grants: [], connect: [] };
        },
    });
    const page = run_in_vm(bundle, {
        chrome: {
            runtime: {
                connect: function (info) {
                    const pair = port_pair(info.name);
                    host.attach_port(pair[1], { script_id: 'sTest', token: 't', tab_id: 9 });
                    return pair[0];
                },
            },
        },
    });
    await tick(30);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['tabs.update', 9, { muted: true }]);
    assert.deepEqual(JSON.parse(JSON.stringify(page.state)), { isMuted: true, muteReason: 'extension', isAudible: true });
    listeners[0](9, { audible: false });
    listeners[0](4, { audible: true });
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(page.change)), { audible: false });
});
