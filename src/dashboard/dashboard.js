import { build, plan, slugify } from '../lib/bundler.js';
import { exportExtension } from '../lib/exporter.js';
import { parseMeta } from '../lib/meta.js';
import { parseSourceUrl, fetchText, listRepoScripts } from '../lib/github.js';
import { permissionsFor, requestPermissionsFor } from '../lib/permissions.js';
import { SCRIPT_OPTIONS, SETTINGS, resolveSettings } from '../lib/settings.js';
import { createSources, loadText } from '../lib/sources.js';
import * as store from '../lib/store.js';
import { EVERY_OPTIONS, applyUpdate, checkForUpdate, newSource } from '../lib/updater.js';
import { zip } from '../lib/zip.js';
import { BUILTIN_MODULES, FEATURES } from '../shared/features.js';

const $ = (id) => document.getElementById(id);
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}
function toast(message, type) {
  const el = h('div', { class: `toast ${type || ''}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3000);
}
const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- state ----------

const S = {
  scripts: {}, modules: {}, settings: resolveSettings({}), status: {}, updates: {},
  sel: null,          // { kind: 'script' | 'module' | 'builtin', id }
  tab: 'code',
  dirty: false,
};
const sources = () => createSources(S.modules);
const current = () => (S.sel?.kind === 'script' ? S.scripts[S.sel.id] : null);

async function loadAll() {
  [S.scripts, S.modules, S.updates] = await Promise.all([store.loadScripts(), store.loadModules(), store.loadUpdates()]);
  S.settings = resolveSettings(await store.loadSettingsRaw());
  applyAppearance();
}

async function loadStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  S.status = res?.value || {};
  $('banner').hidden = S.status.userScripts !== false;
  // Keep checking while the banner is up, so it disappears once the toggle is on.
  if (S.status.userScripts === false) setTimeout(loadStatus, 3000);
}

function applyAppearance() {
  const s = S.settings;
  document.documentElement.dataset.theme = s['editor.theme'] === 'auto' ? '' : s['editor.theme'];
  document.documentElement.style.setProperty('--editor-size', `${s['editor.fontSize']}px`);
  document.documentElement.style.setProperty('--editor-tab', s['editor.tabSize']);
  $('code').classList.toggle('wrap', !!s['editor.wrap']);
  $('code').wrap = s['editor.wrap'] ? 'soft' : 'off';
}

// ---------- sidebar tree ----------

function folderTree(items, pathOf) {
  const root = { folders: new Map(), leaves: [] };
  for (const item of items) {
    let node = root;
    for (const part of pathOf(item)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), leaves: [] });
      node = node.folders.get(part);
    }
    node.leaves.push(item);
  }
  return root;
}
function renderFolder(node, leaf) {
  const out = [];
  for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(h('details', { open: true }, h('summary', null, name), h('div', { class: 'children' }, renderFolder(child, leaf))));
  }
  out.push(...node.leaves.map(leaf));
  return out;
}

function renderTree() {
  const errors = S.status.syncStatus?.errors || {};
  const isSel = (kind, id) => S.sel?.kind === kind && S.sel.id === id;
  const scripts = Object.values(S.scripts).map((s) => ({ ...s, meta: parseMeta(s.code).meta }))
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  const scriptLeaf = (s) => h('div', { class: `leaf${isSel('script', s.id) ? ' selected' : ''}`, onClick: () => select('script', s.id), title: s.meta.description },
    h('span', { class: `dot${s.enabled ? ' on' : ''}`, title: s.enabled ? 'Enabled' : 'Disabled' }),
    h('span', { class: 'label' }, s.meta.name || '(unnamed)'),
    errors[s.id] ? h('span', { class: 'warn', title: errors[s.id] }, '⚠') : null,
    h('span', { class: `chip ${s.options?.sandbox || s.meta.sandbox}` }, s.options?.sandbox || s.meta.sandbox));

  const userModules = Object.keys(S.modules).sort();
  const moduleLeaf = (kind) => (name) => h('div', { class: `leaf${isSel(kind, name) ? ' selected' : ''}`, onClick: () => select(kind, name), title: name },
    h('span', { class: 'label' }, name.split('/').pop()),
    kind === 'module' && BUILTIN_MODULES[name] ? h('span', { class: 'chip', title: 'Shadows the built-in module' }, 'override') : null,
    kind === 'builtin' && S.modules[name] ? h('span', { class: 'hint' }, 'overridden') : null);
  const folderOf = (name) => name.split('/').slice(0, -1);

  $('tree').replaceChildren(...[
    h('h3', null, `Scripts (${scripts.length})`),
    scripts.length ? renderFolder(folderTree(scripts, (s) => (s.meta.folder ? s.meta.folder.split('/').filter(Boolean) : [])), scriptLeaf)
      : h('div', { class: 'empty' }, 'No scripts yet.'),
    h('h3', null, 'My modules'),
    userModules.length ? renderFolder(folderTree(userModules, folderOf), moduleLeaf('module')) : h('div', { class: 'empty' }, 'None yet — “+ Module”.'),
    h('h3', null, 'Built-in modules'),
    renderFolder(folderTree(Object.keys(BUILTIN_MODULES), folderOf), moduleLeaf('builtin')),
  ].flat());
}

// ---------- selection & editor ----------

async function select(kind, id, { force = false } = {}) {
  if (S.dirty && !force && !confirm('Discard unsaved changes?')) return;
  S.sel = { kind, id };
  S.dirty = false;
  $('dirty').hidden = true;
  history.replaceState(null, '', kind === 'script' ? `?id=${id}` : `?module=${encodeURIComponent(id)}`);

  let code = '';
  if (kind === 'script') code = S.scripts[id]?.code ?? '';
  else if (kind === 'module') code = S.modules[id]?.code ?? '';
  else code = await loadText(BUILTIN_MODULES[id]);

  $('empty').hidden = true;
  $('item').hidden = false;
  $('code').value = code;
  $('code').readOnly = kind === 'builtin';
  $('code').scrollTop = 0;
  for (const b of $('tabs').querySelectorAll('[data-for="script"]')) b.hidden = kind !== 'script';
  if (kind !== 'script' && ['options', 'values'].includes(S.tab)) S.tab = 'code';
  renderToolbar();
  renderTabs();
  updateGutter();
  renderTree();
  refreshProblems();
}

function renderToolbar() {
  const { kind, id } = S.sel;
  const s = current();
  const name = $('item-name');
  if (kind === 'script') {
    const meta = parseMeta($('code').value).meta;
    name.value = meta.name || '(unnamed)';
    name.readOnly = true;
    name.title = 'Change the name with @name in the header';
    const mode = s?.options?.sandbox || meta.sandbox;
    $('item-chip').className = `chip ${mode}`;
    $('item-chip').textContent = mode;
  } else {
    name.value = id;
    name.readOnly = kind === 'builtin';
    name.title = kind === 'module' ? 'Module path — edit to rename or move to another folder' : 'Built-in module';
    $('item-chip').className = 'chip';
    $('item-chip').textContent = kind === 'builtin' ? 'built-in' : 'module';
  }
  $('enabled-wrap').hidden = kind !== 'script';
  $('enabled').checked = !!s?.enabled;
  $('export').hidden = kind !== 'script';
  $('update').hidden = !s?.source;
  $('update').title = s?.source ? `Fetch the latest version from ${s.source.label || s.source.url}` : '';
  $('save').hidden = kind === 'builtin';
  $('delete').hidden = kind === 'builtin';
  $('delete').textContent = kind === 'module' && BUILTIN_MODULES[id] ? 'Revert to built-in' : 'Delete';
  $('override').hidden = kind !== 'builtin';
  $('override').textContent = S.modules[id] ? 'Edit override' : 'Override built-in';
}

function renderTabs() {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === S.tab);
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== S.tab;
  if (S.tab === 'options') renderOptions();
  if (S.tab === 'bundle') renderBundle();
  if (S.tab === 'values') renderValues();
}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (!tab) return;
  S.tab = tab;
  renderTabs();
});

function updateGutter() {
  const lines = $('code').value.split('\n').length;
  $('gutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}
$('code').addEventListener('scroll', () => { $('gutter').scrollTop = $('code').scrollTop; });
$('code').addEventListener('input', () => {
  S.dirty = true;
  $('dirty').hidden = false;
  updateGutter();
  refreshProblems();
});
$('code').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || $('code').readOnly) return;
  e.preventDefault();
  document.execCommand('insertText', false, ' '.repeat(S.settings['editor.tabSize'] || 2));
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (S.sel && S.sel.kind !== 'builtin') save();
  }
});
window.addEventListener('beforeunload', (e) => { if (S.dirty) e.preventDefault(); });

const refreshProblems = debounce(async () => {
  if (!S.sel) return;
  const out = [];
  if (S.sel.kind === 'script') {
    const draft = { ...current(), code: $('code').value };
    const p = await plan(draft, { sources: sources(), settings: S.settings });
    out.push(...p.errors.map((m) => h('div', { class: 'err' }, `✖ ${m}`)), ...p.warnings.map((m) => h('div', { class: 'warn' }, `▲ ${m}`)));
    const syncErr = S.status.syncStatus?.errors?.[S.sel.id];
    if (syncErr && !p.errors.length) out.push(h('div', { class: 'err' }, `✖ Last install: ${syncErr}`));
    for (const e of S.status.scriptErrors?.[S.sel.id] || []) {
      out.push(h('div', { class: 'err', title: e.message }, `✖ Runtime error at ${new Date(e.at).toLocaleTimeString()}: ${e.message.split('\n')[0]}`));
    }
    renderToolbar();
    if (S.tab === 'bundle') renderBundle(p);
  }
  $('problems').replaceChildren(...out);
}, 250);

// ---------- save / delete / enable ----------

async function save() {
  const code = $('code').value;
  const { kind, id } = S.sel;
  if (kind === 'script') {
    const missing = await requestPermissionsFor(code); // first await: keeps the user gesture
    const s = await store.putScript({ ...S.scripts[id], code });
    S.scripts[id] = s;
    if (missing.length) toast(`Saved, but without permission for: ${missing.join(', ')}. Those browser APIs will fail.`, 'error');
    else toast('Saved');
  } else {
    const newName = $('item-name').value.trim();
    if (!/^[\w-]+(\/[\w.-]+)*$/.test(newName)) return toast('Module paths look like "folder/name" (letters, digits, - and _).', 'error');
    if (newName !== id) {
      if (S.modules[newName] && !confirm(`Replace the existing module "${newName}"?`)) return;
      await store.removeModule(id);
      delete S.modules[id];
      S.sel.id = newName;
    }
    await store.putModule(newName, code);
    S.modules[newName] = { name: newName, code };
    toast('Module saved — scripts using it are rebuilt');
  }
  S.dirty = false;
  $('dirty').hidden = true;
  renderTree();
  renderToolbar();
}
$('save').onclick = save;

$('enabled').onchange = async () => {
  const on = $('enabled').checked;
  if (on) await requestPermissionsFor($('code').value);
  S.scripts[S.sel.id] = await store.patchScript(S.sel.id, { enabled: on });
  renderTree();
};

$('delete').onclick = async () => {
  const { kind, id } = S.sel;
  if (kind === 'script') {
    if (!confirm(`Delete "${parseMeta(S.scripts[id].code).meta.name}" and its stored values?`)) return;
    await store.removeScript(id);
    delete S.scripts[id];
  } else {
    const users = Object.values(S.scripts).filter((s) => parseMeta(s.code).meta.use.some((u) => u.name === id)).length;
    const msg = BUILTIN_MODULES[id] ? `Drop your override of "${id}" and go back to the built-in?`
      : `Delete module "${id}"?${users ? ` ${users} script(s) use it and will stop working.` : ''}`;
    if (!confirm(msg)) return;
    await store.removeModule(id);
    delete S.modules[id];
  }
  S.dirty = false;
  S.sel = null;
  $('item').hidden = true;
  $('empty').hidden = false;
  history.replaceState(null, '', '?');
  renderTree();
};

$('override').onclick = async () => {
  const id = S.sel.id;
  if (!S.modules[id]) {
    await store.putModule(id, await loadText(BUILTIN_MODULES[id]));
    S.modules[id] = { name: id, code: await loadText(BUILTIN_MODULES[id]) };
  }
  select('module', id, { force: true });
};

// ---------- new / import ----------

function template(site) {
  const s = S.settings;
  const lines = [
    ['name', 'New script'], ['namespace', s['new.namespace']], ['version', '0.1.0'], ['description', 'What does it do?'],
  ];
  if (s['new.folder']) lines.push(['folder', s['new.folder']]);
  if (s['new.sandbox'] !== 'extension') lines.push(['match', site ? `${site}/*` : 'https://example.com/*']);
  if (s['new.sandbox'] !== 'isolated') lines.push(['sandbox', s['new.sandbox']]);
  if (s['new.runAt'] !== 'document-idle') lines.push(['run-at', s['new.runAt']]);
  for (const u of s['new.uses']) lines.push(['use', u]);
  const header = lines.map(([k, v]) => `// @${k.padEnd(12)} ${v}`).join('\n');
  const toastAlias = s['new.uses'].map((u) => /^moss\/ui\/toast as (\w+)$/.exec(u)?.[1]).find(Boolean);
  const body = toastAlias ? `${toastAlias}('Hello from Moss 👋');\n` : `console.log('Hello from Moss 👋');\n`;
  return `// ==UserScript==\n${header}\n// ==/UserScript==\n\n${body}`;
}

async function createScript(code, enabled = false) {
  const s = await store.putScript({ id: store.newId(), code, enabled, createdAt: Date.now() });
  S.scripts[s.id] = s;
  await select('script', s.id, { force: true });
  return s;
}

$('new-script').onclick = () => { if (!S.dirty || confirm('Discard unsaved changes?')) createScript(template()); };

$('new-module').onclick = async () => {
  const name = prompt('Module path (folders allowed), e.g. "utils/dates" or "ui/my-panel":', 'utils/');
  if (!name) return;
  if (!/^[\w-]+(\/[\w.-]+)*$/.test(name)) return toast('Use letters, digits, - and _, separated by "/".', 'error');
  if (S.modules[name]) return select('module', name);
  if (BUILTIN_MODULES[name] && !confirm(`"${name}" is a built-in. Create an override?`)) return;
  const code = `// ${name}\n// Use it from a script with:  // @use ${name} as ${slugify(name.split('/').pop()).replace(/-(\w)/g, (_, c) => c.toUpperCase())}\n` +
    `// Modules see: module, exports, require, api (the calling script's GM functions).\n\nexports.hello = function (who) {\n  return 'Hello, ' + who;\n};\n`;
  await store.putModule(name, code);
  S.modules[name] = { name, code };
  select('module', name, { force: true });
};

// Import dialog: GitHub file / folder / repo, gist, any URL — or a local file.
const IM = { items: [] }; // [{ url, label, path, code, meta, error, checked }]
const everySelect = (value, onChange) => h('select', { onChange: (e) => onChange(Number(e.target.value)) },
  EVERY_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === Number(value) }, o.label)));

$('import').onclick = () => {
  IM.items = [];
  $('im-url').value = '';
  $('im-results').replaceChildren();
  $('im-error').textContent = '';
  $('im-go').disabled = true;
  $('im-update-row').hidden = true;
  $('im-auto').checked = S.settings['update.autoByDefault'];
  $('im-every').replaceWith(Object.assign(everySelect(S.settings['update.every'], () => {}), { id: 'im-every' }));
  $('import-dialog').showModal();
  $('im-url').focus();
};
$('im-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
$('im-lookup').onclick = (e) => { e.preventDefault(); lookup(); };
$('im-file').onclick = (e) => { e.preventDefault(); $('import-dialog').close(); $('import-file').click(); };

function renderPicks() {
  const n = IM.items.filter((i) => i.checked).length;
  $('im-go').disabled = !n;
  $('im-go').textContent = n > 1 ? `Import ${n} scripts` : 'Import';
  $('im-update-row').hidden = !IM.items.some((i) => i.code);
  $('im-results').replaceChildren(h('div', { class: 'pick-list' }, IM.items.map((it) => h('label', { class: `pick${it.code ? '' : ' disabled'}` },
    h('input', { type: 'checkbox', checked: it.checked, disabled: !it.code, onChange: (e) => { it.checked = e.target.checked; renderPicks(); } }),
    h('div', { class: 'what' },
      it.meta ? h('strong', null, it.meta.name, ' ', h('span', { class: 'hint' }, `v${it.meta.version}`), ' ', h('span', { class: `chip ${it.meta.sandbox}` }, it.meta.sandbox)) : h('strong', null, it.path || it.label),
      it.meta?.description ? h('div', null, it.meta.description) : null,
      it.error ? h('div', { class: 'error' }, it.error) : null,
      h('div', { class: 'path' }, it.path || it.label))))));
}

async function lookup() {
  $('im-error').textContent = '';
  $('im-results').replaceChildren(h('p', { class: 'hint' }, 'Looking…'));
  const token = S.settings['github.token'];
  try {
    const src = parseSourceUrl($('im-url').value);
    let files;
    if (src.type === 'repo') {
      files = (await listRepoScripts(src, { token })).map((f) => ({ ...f, label: `${src.owner}/${src.repo}/${f.path}` }));
      if (!files.length) throw new Error(`No .js files in ${src.owner}/${src.repo}${src.dir ? `/${src.dir}` : ''}.`);
      if (files.length > 60) throw new Error(`${files.length} .js files found — link to a folder (…/tree/main/folder) to narrow it down.`);
    } else {
      files = [{ url: src.url, label: src.label }];
    }
    IM.items = await Promise.all(files.map(async (f) => {
      try {
        const code = await fetchText(f.url, { token });
        const { meta, errors } = parseMeta(code);
        if (errors.some((e) => e.startsWith('Missing'))) return { ...f, error: 'Not a userscript (no // ==UserScript== header).' };
        const dup = Object.values(S.scripts).find((x) => x.source?.url === f.url);
        return { ...f, code, meta, checked: !dup, error: dup ? 'Already imported — use ↻ Update on it instead.' : null };
      } catch (e) {
        return { ...f, error: e.message };
      }
    }));
    IM.items.sort((a, b) => !!b.code - !!a.code);
    renderPicks();
  } catch (e) {
    $('im-results').replaceChildren();
    $('im-error').textContent = e.message;
  }
}

$('im-go').onclick = async (e) => {
  e.preventDefault();
  const picked = IM.items.filter((i) => i.checked && i.code);
  const auto = $('im-auto').checked;
  const every = Number($('im-every').value);
  let last;
  for (const it of picked) {
    const source = { ...(await newSource(it.url, it.label, it.code, S.settings)), auto, every };
    last = await store.putScript({ id: store.newId(), code: it.code, enabled: false, source, createdAt: Date.now() });
    S.scripts[last.id] = last;
    await store.recordUpdate(last.id, { status: 'current', error: null });
  }
  $('import-dialog').close();
  if (last) await select('script', last.id, { force: true });
  toast(`Imported ${picked.length === 1 ? `"${picked[0].meta.name}"` : `${picked.length} scripts`} — disabled until you review and enable ${picked.length === 1 ? 'it' : 'them'}.`);
};

$('import-file').onchange = async () => {
  const file = $('import-file').files[0];
  if (file) await importCode(await file.text());
  $('import-file').value = '';
};
async function importCode(code) {
  const { meta, errors } = parseMeta(code);
  if (errors.some((e) => e.startsWith('Missing'))) return toast('That file has no "// ==UserScript==" header.', 'error');
  await createScript(code);
  toast(`Imported "${meta.name}" (disabled — review it, then enable)`);
}

// ---------- updating from the source ----------

async function updateFromSource(s) {
  if (S.dirty && !confirm('You have unsaved changes in the editor. Updating replaces them. Continue?')) return;
  $('update').disabled = true;
  try {
    const r = await checkForUpdate(s, { settings: S.settings, manual: true });
    if (r.status === 'current') {
      await store.recordUpdate(s.id, { status: 'current', error: null });
      return toast('Already up to date');
    }
    if (r.status === 'local-changes' && !confirm('You changed this script in Moss since it was imported. Replace your changes with the latest version from the source?')) {
      return;
    }
    const before = parseMeta(s.code).meta.version;
    S.ownWrite = r.code; // not an outside change: don't announce it twice
    S.scripts[s.id] = await store.putScript(applyUpdate(s, r));
    await store.recordUpdate(s.id, { status: 'updated', version: r.version, updatedAt: Date.now(), error: null });
    S.dirty = false;
    await select('script', s.id, { force: true });
    toast(before === r.version ? `Updated to the latest code (still v${r.version})` : `Updated v${before} → v${r.version}`);
    // A new @grant may need a permission; Save asks for it.
    const missing = [];
    for (const p of permissionsFor(r.code)) if (!(await chrome.permissions.contains({ permissions: [p] }))) missing.push(p);
    if (missing.length) toast(`The new version needs the ${missing.join(', ')} permission — click Save to grant it.`, 'error');
  } catch (e) {
    await store.recordUpdate(s.id, { status: 'error', error: e.message });
    toast(`Update failed: ${e.message}`, 'error');
  } finally {
    $('update').disabled = false;
  }
}
$('update').onclick = () => updateFromSource(current());

$('check-all').onclick = async () => {
  $('check-all').disabled = true;
  $('check-all-result').textContent = 'Checking…';
  const res = await chrome.runtime.sendMessage({ type: 'updates.run' }).catch((e) => ({ ok: false, error: e.message }));
  $('check-all').disabled = false;
  if (!res?.ok) { $('check-all-result').textContent = res?.error || 'Failed'; return; }
  const { checked, updated, errors } = res.value;
  $('check-all-result').textContent = !checked ? 'No imported scripts to check.'
    : `Checked ${checked}. ${updated.length ? `Updated: ${updated.join(', ')}.` : 'Nothing new.'}${errors.length ? ` Problems: ${errors.join('; ')}` : ''}`;
};

$('fix').onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });

// ---------- options pane (per-script overrides) ----------

function schemaInput(def, value, onChange) {
  if (def.type === 'checkbox') return h('input', { type: 'checkbox', class: 'switch', checked: !!value, onChange: (e) => onChange(e.target.checked) });
  if (def.type === 'select') {
    const options = def.options.map((o) => (typeof o === 'object' ? o : { value: o, label: o === '' ? '— from header —' : o }));
    return h('select', { onChange: (e) => onChange(options.find((o) => String(o.value) === e.target.value).value) },
      options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
  }
  if (def.type === 'list') {
    return h('textarea', { rows: 3, placeholder: 'One per line', onChange: (e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)) },
      (value || []).join('\n'));
  }
  if (def.type === 'number') return h('input', { type: 'number', value: value ?? def.default ?? '', onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)) });
  if (def.type === 'password') return h('input', { type: 'password', value: value ?? '', autocomplete: 'off', onChange: (e) => onChange(e.target.value.trim()) });
  return h('input', { type: 'text', value: value ?? '', onChange: (e) => onChange(e.target.value) });
}

// The "Source" box at the top of a script's Options tab.
function sourceBox(s) {
  const src = s.source;
  const u = S.updates[s.id];
  const patch = async (change) => {
    S.scripts[s.id] = await store.patchScript(s.id, { source: change && { ...current().source, ...change } });
    toast('Saved');
    renderOptions();
    renderToolbar();
  };
  if (!src) {
    const input = h('input', { type: 'text', placeholder: 'https://github.com/you/repo/blob/main/script.js' });
    return h('div', { class: 'source-box' },
      h('h3', null, 'Source'),
      h('p', { class: 'hint' }, 'Not linked to a source. Link it to a GitHub file or URL to update it from there.'),
      h('div', { class: 'row' }, input, h('button', { class: 'btn', onClick: async () => {
        try {
          const parsed = parseSourceUrl(input.value);
          if (parsed.type !== 'file') throw new Error('Link to a single file, not a repository or folder.');
          // The current code counts as "fetched", so local edits made from now on are detected.
          await patch(await newSource(parsed.url, parsed.label, current().code, S.settings));
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Link')));
  }
  const status = !u ? 'never checked'
    : `${u.status === 'error' ? 'failed' : { current: 'up to date', updated: `updated${u.version ? ` to v${u.version}` : ''}`, 'local-changes': 'newer version available, but you edited this script here — use ↻ Update', 'not-newer': 'source changed but @version did not go up' }[u.status] || u.status} · checked ${new Date(u.checkedAt).toLocaleString()}`;
  return h('div', { class: 'source-box' },
    h('h3', null, 'Source'),
    h('div', { class: 'row' }, h('code', null, src.label || src.url)),
    h('div', { class: 'row' },
      h('label', { class: 'enabled' }, h('input', { type: 'checkbox', class: 'switch', checked: !!src.auto, onChange: (e) => patch({ auto: e.target.checked }) }), 'Auto-update'),
      everySelect(src.every || S.settings['update.every'], (every) => patch({ every })),
      h('button', { class: 'btn', onClick: () => updateFromSource(current()) }, '↻ Update now'),
      h('button', { class: 'btn ghost', onClick: () => confirm('Unlink this script from its source? It will no longer update.') && patch(null) }, 'Unlink')),
    h('div', { class: u?.error ? 'error' : 'hint' }, u?.error ? `${status} — ${u.error}` : status));
}

async function renderOptions() {
  const s = current();
  if (!s) return;
  const p = await plan({ ...s, code: $('code').value }, { sources: sources(), settings: S.settings });
  const used = Object.fromEntries(p.features.map((f) => [f.name, f.reason]));
  const opts = s.options || {};
  const setOpt = async (key, value) => {
    const next = { ...(current().options || {}) };
    if (value === '' || value == null || (Array.isArray(value) && !value.length)) delete next[key]; else next[key] = value;
    S.scripts[s.id] = await store.patchScript(s.id, { options: next });
    toast('Option saved');
    renderTree();
    refreshProblems();
  };

  const rows = [];
  for (const def of SCRIPT_OPTIONS) {
    let input;
    if (def.type === 'features') {
      input = h('div', { class: 'feature-table' }, def.options.flatMap((name) => [
        h('strong', null, FEATURES[name].label),
        h('select', { onChange: (e) => setOpt('features', { ...(current().options?.features || {}), [name]: e.target.value === 'auto' ? undefined : e.target.value }) },
          ['auto', 'include', 'exclude'].map((v) => h('option', { value: v, selected: (opts.features?.[name] || 'auto') === v }, v))),
        h('span', { class: 'hint' }, used[name] ? `included — ${used[name]}` : 'not included'),
      ]));
    } else {
      input = schemaInput(def, opts[def.key], (v) => setOpt(def.key, v));
    }
    rows.push(h('label', null, def.label), h('div', null, input, def.help ? h('div', { class: 'hint' }, def.help) : null));
  }
  $('options').replaceChildren(...rows);
  $('options-source').replaceChildren(sourceBox(current()));
}

// ---------- bundle inspector ----------

async function renderBundle(given) {
  const box = $('bundle');
  if (S.sel.kind !== 'script') {
    const src = $('code').value;
    const deps = [...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const feats = Object.entries(FEATURES).filter(([, f]) => f.detect.test(src)).map(([n]) => n);
    const users = Object.values(S.scripts).filter((s) => parseMeta(s.code).meta.use.some((u) => u.name === S.sel.id) || s.code.includes(`'${S.sel.id}'`));
    box.replaceChildren(h('div', { class: 'bundle' },
      h('h3', null, 'Requires'), deps.length ? h('ul', { class: 'reasons' }, deps.map((d) => h('li', null, h('code', null, d)))) : h('p', { class: 'hint' }, 'No other modules.'),
      h('h3', null, 'Pulls in runtime features'), h('p', null, feats.length ? feats.join(', ') : h('span', { class: 'hint' }, 'none — it adds nothing beyond its own code')),
      h('h3', null, 'Used by'), users.length ? h('ul', { class: 'reasons' }, users.map((s) => h('li', null, parseMeta(s.code).meta.name))) : h('p', { class: 'hint' }, 'No scripts yet.'),
      h('h3', null, 'Size'), h('p', null, fmtSize(new Blob([src]).size))));
    return;
  }
  const draft = { ...current(), code: $('code').value };
  const p = given || await plan(draft, { sources: sources(), settings: S.settings });
  const t = p.targets;
  const list = (items, render) => (items.length ? h('ul', { class: 'reasons' }, items.map(render)) : h('p', { class: 'hint' }, 'none'));
  const out = h('div', { class: 'bundle' },
    h('h3', null, 'How it runs'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Sandbox'), h('dd', null, h('span', { class: `chip ${p.mode}` }, p.mode)),
      h('dt', null, 'Bridge'), h('dd', null, { port: 'port to the extension', window: 'sandboxed iframe in the background runner', none: 'none (no privileged features used)' }[p.transport] || p.transport),
      h('dt', null, 'Injection'), h('dd', null, p.inject),
      ...(t ? [
        h('dt', null, 'Matches'), h('dd', null, t.matches.join(', ')),
        t.includeGlobs.length ? [h('dt', null, 'Include globs'), h('dd', null, t.includeGlobs.join(', '))] : [],
        t.excludeMatches.length || t.excludeGlobs.length ? [h('dt', null, 'Excludes'), h('dd', null, [...t.excludeMatches, ...t.excludeGlobs].join(', '))] : [],
        t.filter ? [h('dt', null, 'URL filter'), h('dd', null, 'checked at runtime (regex or mixed @match/@include rules)')] : [],
        h('dt', null, 'Run at'), h('dd', null, t.runAt.replace('_', '-')),
        h('dt', null, 'Frames'), h('dd', null, t.allFrames ? 'all frames' : 'top frame only'),
      ] : [h('dt', null, 'Where'), h('dd', null, 'background, no page')]),
    ),
    h('h3', null, 'Runtime features'),
    list(p.features, (f) => h('li', null, h('strong', null, FEATURES[f.name].label), h('span', { class: 'why' }, f.reason))),
    h('h3', null, 'Modules'),
    list(p.modules, (m) => h('li', null, h('code', null, m.name), h('span', { class: 'size' }, fmtSize(new Blob([m.src]).size)))),
    h('h3', null, 'Browser permissions'),
    list([...p.permissions, ...p.hostPermissions], (x) => h('li', null, h('code', null, x.name), h('span', { class: 'why' }, x.reason))),
    p.errors.length ? [h('h3', null, 'Errors'), h('p', { class: 'error' }, p.errors.join('\n'))] : [],
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: showGenerated }, 'Show generated code')),
    h('div', { id: 'generated' }));
  box.replaceChildren(out);

  async function showGenerated() {
    try {
      const st = S.settings;
      const code = await build(p, { sources: sources(), script: draft, token: '•••', settings: st });
      $('generated').replaceChildren(h('p', { class: 'hint' }, `${fmtSize(new Blob([code]).size)} injected`), h('pre', { class: 'generated' }, code));
    } catch (e) {
      $('generated').replaceChildren(h('p', { class: 'error' }, e.message));
    }
  }
}

// ---------- values pane ----------

async function renderValues() {
  const values = await store.loadValues(S.sel.id);
  $('values').value = JSON.stringify(values, null, 2);
}
$('values-save').onclick = async () => {
  try {
    await store.saveValues(S.sel.id, JSON.parse($('values').value || '{}'));
    toast('Values saved — open pages see them after a reload');
  } catch (e) {
    toast(`Not valid JSON: ${e.message}`, 'error');
  }
};
$('values-clear').onclick = async () => {
  if (!confirm('Clear every stored value of this script?')) return;
  await store.saveValues(S.sel.id, {});
  renderValues();
};

// ---------- settings view ----------

function renderSettings() {
  const sections = new Map();
  for (const def of SETTINGS) {
    if (!sections.has(def.section)) sections.set(def.section, []);
    sections.get(def.section).push(def);
  }
  const save = async (key, value) => {
    S.settings = { ...S.settings, [key]: value };
    await store.saveSettings(S.settings);
    applyAppearance();
    toast('Setting saved');
  };
  $('settings').replaceChildren(...[...sections].map(([name, defs]) => h('section', { class: 'settings-section' },
    h('h2', null, name),
    h('div', { class: 'form-grid' }, defs.flatMap((def) => [
      h('label', null, def.label),
      h('div', null, schemaInput(def, S.settings[def.key], (v) => save(def.key, v ?? def.default)), def.help ? h('div', { class: 'hint' }, def.help) : null),
    ])))));
}

$('settings-reset').onclick = async () => {
  if (!confirm('Reset all settings to their defaults? Scripts and modules are not touched.')) return;
  S.settings = resolveSettings({});
  await store.saveSettings({});
  applyAppearance();
  renderSettings();
};

$('backup-export').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  const values = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('values:')));
  const data = { moss: 1, exportedAt: new Date().toISOString(), scripts: all.scripts || {}, modules: all.modules || {}, settings: all.settings || {}, values };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `moss-backup-${new Date().toISOString().slice(0, 10)}.json`);
};
$('backup-import').onclick = () => $('backup-file').click();
$('backup-file').onchange = async () => {
  const file = $('backup-file').files[0];
  $('backup-file').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.moss !== 1) throw new Error('not a Moss backup');
    const n = Object.keys(data.scripts || {}).length;
    if (!confirm(`Restore ${n} script(s) and ${Object.keys(data.modules || {}).length} module(s)? Items with the same id or name are replaced; everything else is kept.`)) return;
    const [scripts, modules] = await Promise.all([store.loadScripts(), store.loadModules()]);
    await chrome.storage.local.set({
      scripts: { ...scripts, ...data.scripts }, modules: { ...modules, ...data.modules },
      settings: { ...S.settings, ...data.settings }, ...data.values,
    });
    await loadAll();
    renderTree();
    renderSettings();
    toast(`Restored ${n} script(s)`);
  } catch (e) {
    toast(`Restore failed: ${e.message}`, 'error');
  }
};

function download(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- views ----------

document.querySelector('.views').addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (!view) return;
  for (const b of document.querySelectorAll('.views button')) b.classList.toggle('active', b.dataset.view === view);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  if (view === 'settings') renderSettings();
});

// ---------- export dialog ----------

const EX = { features: {}, manifestEdited: false, result: null };

async function refreshExport() {
  const s = current();
  const draft = { ...s, code: $('code').value };
  const choices = {
    name: $('ex-name').value.trim() || undefined,
    version: $('ex-version').value.trim() || undefined,
    description: $('ex-description').value,
    features: EX.features,
    includeSource: $('ex-source').checked,
    includeReadme: $('ex-readme').checked,
  };
  if (EX.manifestEdited) {
    try { choices.manifest = JSON.parse($('ex-manifest').value); } catch (e) { $('ex-error').textContent = `manifest.json: ${e.message}`; return; }
  }
  $('ex-error').textContent = '';
  try {
    const result = await exportExtension(draft, { sources: sources(), settings: S.settings, choices });
    EX.result = result;
    const p = result.plan;
    const kept = new Set(p.features.map((f) => f.name));
    const offered = Object.keys(FEATURES).filter((n) => kept.has(n) || EX.features[n] === 'exclude');
    $('ex-features').replaceChildren(...(offered.length ? offered.map((n) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: kept.has(n), onChange: (e) => { EX.features[n] = e.target.checked ? undefined : 'exclude'; refreshExport(); } }),
      h('span', null, h('strong', null, FEATURES[n].label), ' ', h('span', { class: 'hint' }, p.features.find((f) => f.name === n)?.reason || 'excluded')))) : [h('p', { class: 'hint' }, 'None. The script needs no runtime features.')]));
    $('ex-permissions').replaceChildren(...([...p.permissions, ...p.hostPermissions].map((x) => h('li', null, h('code', null, x.name), h('span', { class: 'why' }, x.reason)))));
    if (!$('ex-permissions').children.length) $('ex-permissions').append(h('li', { class: 'hint' }, 'None.'));
    const total = result.files.reduce((n, f) => n + (typeof f.content === 'string' ? new Blob([f.content]).size : f.content.length), 0);
    $('ex-size').textContent = `— ${result.files.length} files, ${fmtSize(total)}`;
    $('ex-files').replaceChildren(...result.files.map((f) => h('li', null, h('code', null, f.path), h('span', { class: 'why' }, f.reason),
      h('span', { class: 'size' }, fmtSize(typeof f.content === 'string' ? new Blob([f.content]).size : f.content.length)))));
    if (!EX.manifestEdited) $('ex-manifest').value = JSON.stringify(result.manifest, null, 2);
  } catch (e) {
    EX.result = null;
    $('ex-error').textContent = e.message;
  }
}

$('export').onclick = async () => {
  if (S.dirty && !confirm('Export uses the code in the editor, including unsaved changes. Continue?')) return;
  const meta = parseMeta($('code').value).meta;
  EX.features = { ...(current().options?.features || {}) };
  EX.manifestEdited = false;
  $('ex-name').value = meta.name;
  $('ex-version').value = meta.version;
  $('ex-description').value = meta.description;
  $('ex-source').checked = S.settings['export.includeSource'];
  $('ex-readme').checked = S.settings['export.includeReadme'];
  $('ex-manifest-wrap').hidden = !S.settings['export.reviewManifest'];
  $('export-dialog').showModal();
  await refreshExport();
};
for (const id of ['ex-name', 'ex-version', 'ex-description']) $(id).addEventListener('input', debounce(() => { EX.manifestEdited = false; refreshExport(); }, 300));
for (const id of ['ex-source', 'ex-readme']) $(id).addEventListener('change', refreshExport);
$('ex-manifest').addEventListener('input', debounce(() => { EX.manifestEdited = true; refreshExport(); }, 400));
$('ex-download').onclick = (e) => {
  e.preventDefault();
  if (!EX.result) return;
  const name = slugify(EX.result.manifest.name);
  download(new Blob([zip(EX.result.files.map((f) => ({ path: `${name}/${f.path}`, content: f.content })))], { type: 'application/zip' }), `${name}-extension.zip`);
  $('export-dialog').close();
  toast(`Exported ${name}-extension.zip`);
};

// ---------- live updates & boot ----------

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'session' && (changes.syncStatus || changes.scriptErrors)) {
    if (changes.syncStatus) S.status.syncStatus = changes.syncStatus.newValue;
    if (changes.scriptErrors) S.status.scriptErrors = changes.scriptErrors.newValue || {};
    renderTree();
    refreshProblems();
  }
  if (area === 'local' && changes.updates) {
    S.updates = changes.updates.newValue || {};
    if (S.tab === 'options' && S.sel?.kind === 'script') $('options-source').replaceChildren(sourceBox(current()));
  }
  if (area === 'local' && (changes.scripts || changes.modules)) {
    // Another page (e.g. the popup) changed something: refresh the list, keep the editor.
    if (changes.scripts) {
      const before = S.sel?.kind === 'script' ? S.scripts[S.sel.id]?.code : null;
      S.scripts = changes.scripts.newValue || {};
      const after = S.sel?.kind === 'script' ? S.scripts[S.sel.id]?.code : null;
      // Changed elsewhere (e.g. an auto-update) while open here.
      if (before != null && after != null && before !== after && after !== $('code').value && after !== S.ownWrite) {
        if (!S.dirty) { await select('script', S.sel.id, { force: true }); toast('This script was updated from its source'); }
        else toast('This script was updated from its source. Saving now would overwrite that update.', 'error');
      }
    }
    if (changes.modules) S.modules = changes.modules.newValue || {};
    if (S.sel?.kind === 'script' && S.scripts[S.sel.id]) $('enabled').checked = !!S.scripts[S.sel.id].enabled;
    renderTree();
  }
});

await loadAll();
await loadStatus();
renderTree();
const params = new URLSearchParams(location.search);
if (params.has('new')) {
  await createScript(template(params.get('new')));
} else if (params.get('id') && S.scripts[params.get('id')]) {
  await select('script', params.get('id'));
} else if (params.get('module')) {
  const m = params.get('module');
  if (S.modules[m]) await select('module', m); else if (BUILTIN_MODULES[m]) await select('builtin', m);
}
