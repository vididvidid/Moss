'use strict';
/*
 * Tests for GitHub links, repo listing, update decisions and the storage migration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetch_text, list_repo_scripts, parse_source_url } from '../src/lib/github.js';
import { EXAMPLE_UPGRADES, migrate_state, upgrade_examples, SCHEMA_VERSION } from '../src/lib/migrate.js';
import { apply_update, check_for_update, compare_versions, source_create } from '../src/lib/updater.js';
import { read } from './helpers.js';

/*
 * userscript(version, body) -> a minimal userscript
 */
function userscript(version, body) {
    return `// ==UserScript==\n// @name Demo\n// @version ${version}\n// @match *://*/*\n// ==/UserScript==\n${body || ''}`;
}

/*
 * server(files) -> { fetch_impl, seen }: a fake fetch serving the url → body map
 */
function server(files) {
    const seen = [];
    return {
        seen: seen,
        fetch_impl: async function (url, init) {
            seen.push({ url: url, init: init });
            const key = url.replace(/[?&]moss=\d+/, '');
            if (!(key in files)) {
                return { ok: false, status: 404, text: async function () { return ''; } };
            }
            const body = files[key];
            return {
                ok: true,
                status: 200,
                text: async function () {
                    return typeof body === 'string' ? body : JSON.stringify(body);
                },
                json: async function () {
                    return body;
                },
            };
        },
    };
}

test('GitHub links become raw file URLs or repo listings', function () {
    assert.deepEqual(parse_source_url('https://github.com/me/DailyScripts/blob/main/tools/fire Button.js'),
        { type: 'file', url: 'https://raw.githubusercontent.com/me/DailyScripts/main/tools/fire%20Button.js', label: 'me/DailyScripts/tools/fire Button.js' });
    assert.equal(parse_source_url('https://raw.githubusercontent.com/me/r/main/a.js').url, 'https://raw.githubusercontent.com/me/r/main/a.js');
    assert.deepEqual(parse_source_url('https://github.com/me/DailyScripts'), { type: 'repo', owner: 'me', repo: 'DailyScripts', ref: 'HEAD', dir: '' });
    assert.deepEqual(parse_source_url('https://github.com/me/r.git'), { type: 'repo', owner: 'me', repo: 'r', ref: 'HEAD', dir: '' });
    assert.deepEqual(parse_source_url('https://github.com/me/r/tree/dev/scripts/yt'), { type: 'repo', owner: 'me', repo: 'r', ref: 'dev', dir: 'scripts/yt' });
    assert.equal(parse_source_url('https://gist.github.com/me/abc123').url, 'https://gist.githubusercontent.com/me/abc123/raw');
    assert.equal(parse_source_url('https://example.com/x.user.js').type, 'file');
    assert.throws(function () { parse_source_url('github.com/me/r'); }, /not a valid URL/);
    assert.throws(function () { parse_source_url('https://github.com/me/r/issues/3'); }, /can't import GitHub "issues"/);
});

test('repo listing keeps .js files under the folder and builds tracked raw URLs', async function () {
    const fake = server({
        'https://api.github.com/repos/me/r/git/trees/HEAD?recursive=1': {
            tree: [
                { type: 'blob', path: 'a.js' }, { type: 'blob', path: 'README.md' }, { type: 'tree', path: 'sub' },
                { type: 'blob', path: 'sub/b.js' }, { type: 'blob', path: 'other/c.js' },
            ],
        },
    });
    const all = await list_repo_scripts({ owner: 'me', repo: 'r', ref: 'HEAD', dir: '' }, { fetch_impl: fake.fetch_impl, token: 'tok' });
    assert.deepEqual(Array.from(all, function (f) { return f.path; }), ['a.js', 'sub/b.js', 'other/c.js']);
    assert.equal(all[1].url, 'https://raw.githubusercontent.com/me/r/HEAD/sub/b.js');
    assert.equal(fake.seen[0].init.headers.Authorization, 'Bearer tok');
    const sub = await list_repo_scripts({ owner: 'me', repo: 'r', ref: 'HEAD', dir: 'sub' }, { fetch_impl: fake.fetch_impl });
    assert.deepEqual(Array.from(sub, function (f) { return f.path; }), ['sub/b.js']);
    await assert.rejects(list_repo_scripts({ owner: 'me', repo: 'nope', ref: 'HEAD', dir: '' }, { fetch_impl: fake.fetch_impl }), /not found.*token/);
});

test('token is only sent to GitHub, and manual checks bust caches', async function () {
    const fake = server({ 'https://example.com/a.js': 'x', 'https://raw.githubusercontent.com/me/r/main/a.js': 'y' });
    await fetch_text('https://example.com/a.js', { token: 'secret', fetch_impl: fake.fetch_impl });
    await fetch_text('https://raw.githubusercontent.com/me/r/main/a.js', { token: 'secret', bust: true, fetch_impl: fake.fetch_impl });
    assert.equal(fake.seen[0].init.headers.Authorization, undefined);
    assert.equal(fake.seen[1].init.headers.Authorization, 'Bearer secret');
    assert.match(fake.seen[1].url, /\?moss=\d+$/);
});

test('update decisions: current, update, local edits, @version rule', async function () {
    const url = 'https://raw.githubusercontent.com/me/r/main/demo.js';
    const files = {};
    files[url] = userscript('1.0.0', 'a()');
    const fake = server(files);
    const settings = { 'update.every': 60, 'update.auto_by_default': true };
    const opts = { settings: settings, fetch_impl: fake.fetch_impl };
    let s = { id: 's1', code: files[url], source: await source_create(url, 'demo', files[url], settings) };
    assert.equal(s.source.auto, true);
    assert.equal((await check_for_update(s, opts)).status, 'current');

    files[url] = userscript('1.1.0', 'b()');
    const check = await check_for_update(s, opts);
    assert.equal(check.status, 'update');
    assert.equal(check.version, '1.1.0');
    s = apply_update(s, check);
    assert.equal(s.code, files[url]);
    assert.ok(s.source.updated_at > 0);
    assert.equal((await check_for_update(s, opts)).status, 'current');

    // Edited in Moss → auto-update leaves it alone (manual also reports it; the UI asks first).
    s = Object.assign({}, s, { code: s.code + '\n// my tweak' });
    assert.equal((await check_for_update(s, opts)).status, 'current', 'upstream unchanged: keep local edits');
    files[url] = userscript('1.2.0', 'c()');
    assert.equal((await check_for_update(s, opts)).status, 'local-changes');
    const overwrite = { settings: Object.assign({}, settings, { 'update.overwrite_local': true }), fetch_impl: fake.fetch_impl };
    assert.equal((await check_for_update(s, overwrite)).status, 'update');

    // "Only when @version goes up": a change without a bump is skipped by auto, taken by manual.
    s = apply_update(s, await check_for_update(s, overwrite));
    files[url] = userscript('1.2.0', 'd()');
    const strict = { settings: Object.assign({}, settings, { 'update.require_newer_version': true }), fetch_impl: fake.fetch_impl };
    assert.equal((await check_for_update(s, strict)).status, 'not-newer');
    assert.equal((await check_for_update(s, Object.assign({ manual: true }, strict))).status, 'update');

    files[url] = 'console.log("not a userscript")';
    await assert.rejects(check_for_update(s, opts), /no "\/\/ ==UserScript==" header/);
    delete files[url];
    await assert.rejects(check_for_update(s, opts), /404.*token/);
});

test('version comparison', function () {
    assert.equal(compare_versions('1.10.0', '1.9.9'), 1);
    assert.equal(compare_versions('2.0', '2.0.0'), 0);
    assert.equal(compare_versions('0.1.0', '0.2'), -1);
});

// A snapshot of storage as Moss 0.1.0 wrote it.
const V1 = {
    scripts: {
        s1: {
            id: 's1', code: 'x', enabled: true, createdAt: 1, updatedAt: 2,
            options: { runAt: 'document-start', allFrames: 'no', sandbox: 'page' },
            source: { url: 'https://a/b.js', label: 'b', hash: 'h', auto: true, every: 60, updatedAt: 3 },
        },
        s2: { id: 's2', code: 'y', enabled: false, createdAt: 4, updatedAt: 5, options: {} },
    },
    modules: { 'utils/text': { name: 'utils/text', code: 'm', updatedAt: 6 } },
    settings: { 'editor.fontSize': 15, 'update.autoByDefault': false, 'security.chromeNamespaces': ['tabs'], 'github.token': 't' },
    updates: { s1: { checkedAt: 7, status: 'current', error: null } },
    requireCache: { 'https://lib': { code: 'lib', at: 8 } },
};

test('migration: v1 camelCase storage becomes v2 snake_case, once', function () {
    const result = migrate_state(structuredClone(V1));
    assert.equal(result.changed, true);
    const d = result.data;
    assert.equal(d.schema_version, SCHEMA_VERSION);
    assert.deepEqual(d.scripts.s1, {
        id: 's1', code: 'x', enabled: true, created_at: 1, updated_at: 2,
        options: { run_at: 'document-start', all_frames: 'no', sandbox: 'page' },
        source: { url: 'https://a/b.js', label: 'b', hash: 'h', auto: true, every: 60, updated_at: 3 },
    });
    assert.equal(d.scripts.s2.source, null);
    assert.deepEqual(d.modules['utils/text'], { name: 'utils/text', code: 'm', updated_at: 6 });
    assert.deepEqual(d.settings, { 'editor.font_size': 15, 'update.auto_by_default': false, 'security.chrome_namespaces': ['tabs'], 'github.token': 't' });
    assert.deepEqual(d.updates.s1, { checked_at: 7, status: 'current', error: null });
    assert.deepEqual(d.require_cache, V1.requireCache);
    assert.equal(d.requireCache, undefined);

    const again = migrate_state(d);
    assert.equal(again.changed, false, 'running it twice changes nothing');
    assert.equal(again.data, d);
});

test('migration: untouched 0.1.0 examples are upgraded, edited ones kept', async function () {
    // The 0.1.0 example files, kept verbatim as fixtures (.txt so the style checker skips them).
    const old_files = {
        'page-tools.user.js': read('tests/fixtures/v1/page-tools.user.js.txt'),
        'fetch-logger.user.js': read('tests/fixtures/v1/fetch-logger.user.js.txt'),
        'utils-text.js': read('tests/fixtures/v1/utils-text.js.txt'),
    };
    for (const name of Object.keys(old_files)) {
        const hash = createHash('sha256').update(old_files[name]).digest('hex');
        assert.equal(EXAMPLE_UPGRADES[hash], `src/examples/${name}`, `hash of the 0.1.0 ${name}`);
    }

    const scripts = {
        a: { code: old_files['page-tools.user.js'] },
        b: { code: old_files['fetch-logger.user.js'] + '\n// edited' },
    };
    const modules = { 'utils/text': { code: old_files['utils-text.js'] } };
    const count = await upgrade_examples(scripts, modules, async function (path) {
        return read(path);
    });
    assert.equal(count, 2);
    assert.equal(scripts.a.code, read('src/examples/page-tools.user.js'));
    assert.equal(modules['utils/text'].code, read('src/examples/utils-text.js'));
    assert.ok(scripts.b.code.endsWith('// edited'), 'edited copies are left alone');
});
