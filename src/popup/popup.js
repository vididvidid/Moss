import { parseMeta, urlMatches } from '../lib/meta.js';
import { loadScripts, patchScript } from '../lib/store.js';
import { requestPermissionsFor } from '../lib/permissions.js';

const $ = (id) => document.getElementById(id);
const dashboard = (query = '') => chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html${query}`) }).then(() => window.close());

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = tab?.url || '';
const scripts = Object.values(await loadScripts()).map((s) => ({ ...s, meta: parseMeta(s.code).meta }));
const status = (await chrome.runtime.sendMessage({ type: 'status' }))?.value || {};
const errors = status.syncStatus?.errors || {};
const runtimeErrors = status.scriptErrors || {};

$('banner').hidden = status.userScripts !== false;
$('fix').onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
$('open-dashboard').onclick = () => dashboard();
$('new-here').onclick = () => dashboard(/^https?:/.test(url) ? `?new=${encodeURIComponent(new URL(url).origin)}` : '?new=');

function row(s) {
  const toggle = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'switch', checked: !!s.enabled });
  toggle.title = s.enabled ? 'Disable' : 'Enable';
  toggle.onchange = async () => {
    if (toggle.checked) await requestPermissionsFor(s.code);
    await patchScript(s.id, { enabled: toggle.checked });
  };
  const name = Object.assign(document.createElement('span'), { className: 'name', textContent: s.meta.name || '(unnamed)' });
  name.onclick = () => dashboard(`?id=${s.id}`);
  const mode = s.options?.sandbox || s.meta.sandbox;
  const chip = Object.assign(document.createElement('span'), { className: `chip ${mode}`, textContent: mode });
  const li = document.createElement('li');
  li.append(toggle, name, chip);
  if (errors[s.id]) li.append(Object.assign(document.createElement('span'), { className: 'error', textContent: '⚠', title: errors[s.id] }));
  const latest = runtimeErrors[s.id]?.[0];
  if (!latest) return li;
  // Show the latest runtime error under the script; click to dismiss it.
  const msg = Object.assign(document.createElement('div'), { className: 'error-line', title: `${latest.message}\n\nClick to dismiss` });
  msg.textContent = `⚠ ${latest.message.split('\n')[0]}`;
  msg.onclick = async () => { await chrome.runtime.sendMessage({ type: 'errors.clear', id: s.id }); msg.remove(); };
  const wrap = document.createElement('div');
  wrap.append(li, msg);
  return wrap;
}

function fill(list, items, empty) {
  list.replaceChildren(...items);
  if (!items.length && empty) list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: empty }));
}

const mode = (s) => s.options?.sandbox || s.meta.sandbox;
const onPage = scripts.filter((s) => mode(s) !== 'extension' && urlMatches(s.meta, url, s.options));
fill($('page-scripts'), onPage.map(row), 'No scripts match this page.');

const background = scripts.filter((s) => mode(s) === 'extension');
$('bg-section').hidden = !background.length;
fill($('bg-scripts'), background.map(row));

const menus = (await chrome.runtime.sendMessage({ type: 'menu.list', tabId: tab?.id ?? -1 }))?.value || [];
$('commands-section').hidden = !menus.length;
const names = Object.fromEntries(scripts.map((s) => [s.id, s.meta.name]));
fill($('commands'), menus.map((m) => {
  const li = document.createElement('li');
  li.className = 'command';
  li.append(Object.assign(document.createElement('span'), { className: 'name', textContent: m.caption }),
    Object.assign(document.createElement('span'), { className: 'from', textContent: names[m.scriptId] || '' }));
  li.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'menu.run', conn: m.conn, id: m.id });
    window.close();
  };
  return li;
}));
