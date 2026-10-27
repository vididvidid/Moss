import test from 'node:test';
import assert from 'node:assert/strict';
import { listRepoScripts, parseSourceUrl, fetchText } from '../src/lib/github.js';
import { applyUpdate, checkForUpdate, compareVersions, newSource } from '../src/lib/updater.js';

const userscript = (version, body = '') => `// ==UserScript==\n// @name Demo\n// @version ${version}\n// @match *://*/*\n// ==/UserScript==\n${body}`;

// Fake fetch serving a mutable map of url → body; records requests.
function server(files) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const key = url.replace(/[?&]moss=\d+/, '');
    if (!(key in files)) return { ok: false, status: 404, text: async () => '' };
    const body = files[key];
    return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { fetchImpl, seen };
}

test('GitHub links become raw file URLs or repo listings', () => {
  assert.deepEqual(parseSourceUrl('https://github.com/me/DailyScripts/blob/main/tools/fire Button.js'),
    { type: 'file', url: 'https://raw.githubusercontent.com/me/DailyScripts/main/tools/fire%20Button.js', label: 'me/DailyScripts/tools/fire Button.js' });
  assert.equal(parseSourceUrl('https://raw.githubusercontent.com/me/r/main/a.js').url, 'https://raw.githubusercontent.com/me/r/main/a.js');
  assert.deepEqual(parseSourceUrl('https://github.com/me/DailyScripts'), { type: 'repo', owner: 'me', repo: 'DailyScripts', ref: 'HEAD', dir: '' });
  assert.deepEqual(parseSourceUrl('https://github.com/me/r.git'), { type: 'repo', owner: 'me', repo: 'r', ref: 'HEAD', dir: '' });
  assert.deepEqual(parseSourceUrl('https://github.com/me/r/tree/dev/scripts/yt'), { type: 'repo', owner: 'me', repo: 'r', ref: 'dev', dir: 'scripts/yt' });
  assert.equal(parseSourceUrl('https://gist.github.com/me/abc123').url, 'https://gist.githubusercontent.com/me/abc123/raw');
  assert.equal(parseSourceUrl('https://example.com/x.user.js').type, 'file');
  assert.throws(() => parseSourceUrl('github.com/me/r'), /not a valid URL/);
  assert.throws(() => parseSourceUrl('https://github.com/me/r/issues/3'), /can't import GitHub "issues"/);
});

test('repo listing keeps .js files under the folder and builds tracked raw URLs', async () => {
  const { fetchImpl, seen } = server({
    'https://api.github.com/repos/me/r/git/trees/HEAD?recursive=1': { tree: [
      { type: 'blob', path: 'a.js' }, { type: 'blob', path: 'README.md' }, { type: 'tree', path: 'sub' },
      { type: 'blob', path: 'sub/b.js' }, { type: 'blob', path: 'other/c.js' },
    ] },
  });
  const all = await listRepoScripts({ owner: 'me', repo: 'r', ref: 'HEAD', dir: '' }, { fetchImpl, token: 'tok' });
  assert.deepEqual(all.map((f) => f.path), ['a.js', 'sub/b.js', 'other/c.js']);
  assert.equal(all[1].url, 'https://raw.githubusercontent.com/me/r/HEAD/sub/b.js');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
  const sub = await listRepoScripts({ owner: 'me', repo: 'r', ref: 'HEAD', dir: 'sub' }, { fetchImpl });
  assert.deepEqual(sub.map((f) => f.path), ['sub/b.js']);
  await assert.rejects(listRepoScripts({ owner: 'me', repo: 'nope', ref: 'HEAD', dir: '' }, { fetchImpl }), /not found.*token/);
});

test('token is only sent to GitHub, and manual checks bust caches', async () => {
  const { fetchImpl, seen } = server({ 'https://example.com/a.js': 'x', 'https://raw.githubusercontent.com/me/r/main/a.js': 'y' });
  await fetchText('https://example.com/a.js', { token: 'secret', fetchImpl });
  await fetchText('https://raw.githubusercontent.com/me/r/main/a.js', { token: 'secret', bust: true, fetchImpl });
  assert.equal(seen[0].init.headers.Authorization, undefined);
  assert.equal(seen[1].init.headers.Authorization, 'Bearer secret');
  assert.match(seen[1].url, /\?moss=\d+$/);
});

test('update decisions: current, update, local edits, @version rule', async () => {
  const URL_ = 'https://raw.githubusercontent.com/me/r/main/demo.js';
  const files = { [URL_]: userscript('1.0.0', 'a()') };
  const { fetchImpl } = server(files);
  const settings = { 'update.every': 60, 'update.autoByDefault': true };
  let script = { id: 's1', code: files[URL_], source: await newSource(URL_, 'demo', files[URL_], settings) };
  assert.equal(script.source.auto, true);

  assert.equal((await checkForUpdate(script, { settings, fetchImpl })).status, 'current');

  files[URL_] = userscript('1.1.0', 'b()');
  const r = await checkForUpdate(script, { settings, fetchImpl });
  assert.equal(r.status, 'update');
  assert.equal(r.version, '1.1.0');
  script = applyUpdate(script, r);
  assert.equal(script.code, files[URL_]);
  assert.equal((await checkForUpdate(script, { settings, fetchImpl })).status, 'current');

  // Edited in Moss → auto-update leaves it alone (manual also reports it; the UI asks first).
  script = { ...script, code: script.code + '\n// my tweak' };
  assert.equal((await checkForUpdate(script, { settings, fetchImpl })).status, 'current', 'upstream unchanged: keep local edits');
  files[URL_] = userscript('1.2.0', 'c()');
  assert.equal((await checkForUpdate(script, { settings, fetchImpl })).status, 'local-changes');
  assert.equal((await checkForUpdate(script, { settings: { ...settings, 'update.overwriteLocal': true }, fetchImpl })).status, 'update');

  // "Only when @version goes up": a change without a bump is skipped by auto, taken by manual.
  script = applyUpdate(script, await checkForUpdate(script, { settings: { ...settings, 'update.overwriteLocal': true }, fetchImpl }));
  files[URL_] = userscript('1.2.0', 'd()');
  const strict = { ...settings, 'update.requireNewerVersion': true };
  assert.equal((await checkForUpdate(script, { settings: strict, fetchImpl })).status, 'not-newer');
  assert.equal((await checkForUpdate(script, { settings: strict, fetchImpl, manual: true })).status, 'update');

  files[URL_] = 'console.log("not a userscript")';
  await assert.rejects(checkForUpdate(script, { settings, fetchImpl }), /no "\/\/ ==UserScript==" header/);
  delete files[URL_];
  await assert.rejects(checkForUpdate(script, { settings, fetchImpl }), /404.*token/);
});

test('version comparison', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2'), -1);
});
