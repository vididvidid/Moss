'use strict';
/*
 * The Moss dashboard: sidebar tree, editor, per-script tabs (code, options, bundle,
 * values), settings, import/update and export.
 *
 * struct app {                     everything the page knows, in one place
 *     scripts, modules, updates: as stored (see store.js);
 *     enabled: boolean;            global on/off (moss_enabled)
 *     settings: resolved settings;
 *     status: { user_scripts, sync_status, script_errors };
 *     sel: { kind: 'script' | 'module' | 'builtin', id } | null;
 *     tab: 'code' | 'options' | 'bundle' | 'values';
 *     dirty: boolean;              editor differs from what is saved
 *     own_write: string | null;    code we just wrote ourselves (not an outside change)
 *     local: { [id]: { modified, error } };   scripts linked to a file on this computer
 * }
 */
import { build, plan, slugify } from '../lib/bundler.js';
import { export_extension } from '../lib/exporter.js';
import { fetch_text, list_repo_scripts, parse_source_url } from '../lib/github.js';
import { parse_meta } from '../lib/meta.js';
import { migrate_state, SCHEMA_VERSION } from '../lib/migrate.js';
import { has_access, load_handle, pick_file, read_file, reconnect, remove_handle, save_handle } from '../lib/local_files.js';
import { missing_permissions, request_permissions_for } from '../lib/permissions.js';
import { SCRIPT_OPTIONS, SETTINGS, resolve_settings } from '../lib/settings.js';
import { load_text, sources_create } from '../lib/sources.js';
import * as store from '../lib/store.js';
import { EVERY_OPTIONS, apply_update, check_for_update, sha256, source_create } from '../lib/updater.js';
import { zip } from '../lib/zip.js';
import { BUILTIN_MODULES, FEATURES } from '../shared/features.js';

const MODULE_NAME_RE = /^[\w-]+(\/[\w.-]+)*$/;

const app = {
    scripts: {},
    modules: {},
    updates: {},
    enabled: true,
    settings: resolve_settings({}),
    status: {},
    sel: null,
    tab: 'code',
    dirty: false,
    own_write: null,
    local: {},          // script id -> { modified, error } for scripts linked to a local file
};

// ---------- small helpers ----------

/*
 * $(id) -> the element with that id
 */
function $(id) {
    return document.getElementById(id);
}

/*
 * value_or(value, fallback) -> value unless it is null/undefined
 */
function value_or(value, fallback) {
    return value === null || value === undefined ? fallback : value;
}

/*
 * append_children(el, children) — append nodes/strings, flattening nested arrays
 */
function append_children(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        if (Array.isArray(child)) {
            append_children(el, child);
        } else {
            el.append(child);
        }
    }
}

/*
 * h(tag, props, ...children) -> a new element
 *   props: class, on_<event> handlers, attributes, properties
 */
function h(tag, props) {
    const el = document.createElement(tag);
    const p = props || {};
    for (const key of Object.keys(p)) {
        const value = p[key];
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key.startsWith('on_')) {
            el.addEventListener(key.slice(3), value);
        } else if (key === 'class') {
            el.className = value;
        } else if (key in el && typeof value !== 'string') {
            el[key] = value;
        } else {
            el.setAttribute(key, value === true ? '' : value);
        }
    }
    append_children(el, Array.prototype.slice.call(arguments, 2));
    return el;
}

/*
 * toast(message, type) — a short notice in the corner ('error' stays longer)
 */
function toast(message, type) {
    const el = h('div', { class: `toast ${type || ''}` }, message);
    $('toasts').append(el);
    setTimeout(function () {
        el.remove();
    }, type === 'error' ? 7000 : 3000);
}

/*
 * format_size(bytes) -> "512 B" / "3.4 KB"
 */
function format_size(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/*
 * byte_size(content) -> size in bytes of a string (UTF-8) or Uint8Array
 */
function byte_size(content) {
    return typeof content === 'string' ? new Blob([content]).size : content.length;
}

/*
 * debounce(fn, ms) -> a function that runs fn once calls stop for ms
 */
function debounce(fn, ms) {
    let timer = null;
    return function () {
        const args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () {
            fn.apply(null, args);
        }, ms);
    };
}

/*
 * sources() -> struct sources over the current user modules
 */
function sources() {
    return sources_create(app.modules);
}

/*
 * current() -> the selected struct script, or null
 */
function current() {
    if (app.sel === null || app.sel.kind !== 'script') {
        return null;
    }
    return value_or(app.scripts[app.sel.id], null);
}

/*
 * mode_of(s, meta) -> the sandbox a script runs in, options first
 */
function mode_of(s, meta) {
    return (s && s.options && s.options.sandbox) || meta.sandbox;
}

/*
 * first_line(text) -> text up to the first line break
 */
function first_line(text) {
    return text.split('\n')[0];
}

/*
 * script_uses(s, module_name) -> true if a script pulls in module_name
 */
function script_uses(s, module_name) {
    for (const use of parse_meta(s.code).meta.use) {
        if (use.name === module_name) {
            return true;
        }
    }
    return s.code.includes(`'${module_name}'`);
}

/*
 * reason_list(items, empty) -> a <ul> of { name, reason } rows, or an "empty" note
 */
function reason_list(items, empty) {
    if (items.length === 0) {
        return h('p', { class: 'hint' }, empty || 'none');
    }
    const rows = [];
    for (const item of items) {
        rows.push(h('li', null, h('code', null, item.name), h('span', { class: 'why' }, item.reason)));
    }
    return h('ul', { class: 'reasons' }, rows);
}

/*
 * download(blob, filename) — save a file through the browser
 */
function download(blob, filename) {
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () {
        URL.revokeObjectURL(a.href);
    }, 5000);
}

// ---------- loading ----------

/*
 * load_all() — read scripts, modules, updates and settings from storage
 */
async function load_all() {
    app.scripts = await store.load_scripts();
    app.modules = await store.load_modules();
    app.updates = await store.load_updates();
    app.enabled = await store.load_moss_enabled();
    app.settings = resolve_settings(await store.load_settings_raw());
    apply_appearance();
}

/*
 * load_status() — ask the service worker for the user-scripts toggle and errors
 */
async function load_status() {
    let reply = null;
    try {
        reply = await chrome.runtime.sendMessage({ type: 'status' });
    } catch (e) {
        reply = null;
    }
    app.status = reply && reply.ok ? reply.value : {};
    $('banner').hidden = app.status.user_scripts !== false;
    // Keep checking while the banner is up, so it disappears once the toggle is on.
    if (app.status.user_scripts === false) {
        setTimeout(load_status, 3000);
    }
}

/*
 * apply_appearance() — theme and editor settings
 */
function apply_appearance() {
    const s = app.settings;
    document.documentElement.dataset.theme = s['editor.theme'] === 'auto' ? '' : s['editor.theme'];
    document.documentElement.style.setProperty('--editor-size', `${s['editor.font_size']}px`);
    document.documentElement.style.setProperty('--editor-tab', s['editor.tab_size']);
    $('code').classList.toggle('wrap', !!s['editor.wrap']);
    $('code').wrap = s['editor.wrap'] ? 'soft' : 'off';
}

// ---------- sidebar tree ----------

/*
 * folder_tree(items, path_of) -> { folders: Map<name, node>, leaves: items[] }
 */
function folder_tree(items, path_of) {
    const root = { folders: new Map(), leaves: [] };
    for (const item of items) {
        let node = root;
        for (const part of path_of(item)) {
            if (!node.folders.has(part)) {
                node.folders.set(part, { folders: new Map(), leaves: [] });
            }
            node = node.folders.get(part);
        }
        node.leaves.push(item);
    }
    return root;
}

/*
 * render_folder(node, leaf) -> elements for a folder node: sub-folders first, then leaves
 */
function render_folder(node, leaf) {
    const out = [];
    const names = Array.from(node.folders.keys()).sort();
    for (const name of names) {
        out.push(h('details', { open: true },
            h('summary', null, name),
            h('div', { class: 'children' }, render_folder(node.folders.get(name), leaf))));
    }
    for (const item of node.leaves) {
        out.push(leaf(item));
    }
    return out;
}

/*
 * is_selected(kind, id) -> true if that item is open in the editor
 */
function is_selected(kind, id) {
    return app.sel !== null && app.sel.kind === kind && app.sel.id === id;
}

/*
 * script_leaf(s) -> sidebar row for a script (s carries its parsed .meta)
 */
function script_leaf(s) {
    const sync_errors = app.status.sync_status ? app.status.sync_status.errors || {} : {};
    const mode = mode_of(s, s.meta);
    return h('div', {
        class: `leaf${is_selected('script', s.id) ? ' selected' : ''}`,
        title: s.meta.description,
        on_click: function () {
            select('script', s.id);
        },
    },
    h('span', { class: `dot${s.enabled ? ' on' : ''}`, title: s.enabled ? 'Enabled' : 'Disabled' }),
    h('span', { class: 'label' }, s.meta.name || '(unnamed)'),
    sync_errors[s.id] ? h('span', { class: 'warn', title: sync_errors[s.id] }, '⚠') : null,
    h('span', { class: `chip ${mode}` }, mode));
}

/*
 * module_leaf(kind, name) -> sidebar row for a user or built-in module
 */
function module_leaf(kind, name) {
    const parts = name.split('/');
    return h('div', {
        class: `leaf${is_selected(kind, name) ? ' selected' : ''}`,
        title: name,
        on_click: function () {
            select(kind, name);
        },
    },
    h('span', { class: 'label' }, parts[parts.length - 1]),
    kind === 'module' && BUILTIN_MODULES[name] ? h('span', { class: 'chip', title: 'Shadows the built-in module' }, 'override') : null,
    kind === 'builtin' && app.modules[name] ? h('span', { class: 'hint' }, 'overridden') : null);
}

/*
 * module_folder(name) -> the folder parts of a module path
 */
function module_folder(name) {
    return name.split('/').slice(0, -1);
}

/*
 * script_folder(s) -> the folder parts of a script's @folder
 */
function script_folder(s) {
    const parts = [];
    for (const part of s.meta.folder.split('/')) {
        if (part !== '') {
            parts.push(part);
        }
    }
    return parts;
}

/*
 * render_tree() — redraw the sidebar
 */
function render_tree() {
    const scripts = [];
    for (const id of Object.keys(app.scripts)) {
        scripts.push(Object.assign({}, app.scripts[id], { meta: parse_meta(app.scripts[id].code).meta }));
    }
    scripts.sort(function (a, b) {
        return a.meta.name.localeCompare(b.meta.name);
    });
    const user_modules = Object.keys(app.modules).sort();

    const nodes = [h('h3', null, `Scripts (${scripts.length})`)];
    if (scripts.length > 0) {
        nodes.push(render_folder(folder_tree(scripts, script_folder), script_leaf));
    } else {
        nodes.push(h('div', { class: 'empty' }, 'No scripts yet.'));
    }
    nodes.push(h('h3', null, 'My modules'));
    if (user_modules.length > 0) {
        nodes.push(render_folder(folder_tree(user_modules, module_folder), function (name) {
            return module_leaf('module', name);
        }));
    } else {
        nodes.push(h('div', { class: 'empty' }, 'None yet — “+ Module”.'));
    }
    nodes.push(h('h3', null, 'Built-in modules'));
    nodes.push(render_folder(folder_tree(Object.keys(BUILTIN_MODULES), module_folder), function (name) {
        return module_leaf('builtin', name);
    }));
    const tree = $('tree');
    tree.replaceChildren();
    append_children(tree, nodes);
}

// ---------- selection & editor ----------

/*
 * select(kind, id, force) — open an item in the editor (asks first if there are unsaved edits)
 */
async function select(kind, id, force) {
    if (app.dirty && !force && !confirm('Discard unsaved changes?')) {
        return;
    }
    app.sel = { kind: kind, id: id };
    app.dirty = false;
    $('dirty').hidden = true;
    history.replaceState(null, '', kind === 'script' ? `?id=${id}` : `?module=${encodeURIComponent(id)}`);

    let code = '';
    if (kind === 'script') {
        code = app.scripts[id] ? app.scripts[id].code : '';
    } else if (kind === 'module') {
        code = app.modules[id] ? app.modules[id].code : '';
    } else {
        code = await load_text(BUILTIN_MODULES[id]);
    }

    $('empty').hidden = true;
    $('item').hidden = false;
    $('code').value = code;
    $('code').readOnly = kind === 'builtin';
    $('code').scrollTop = 0;
    for (const button of $('tabs').querySelectorAll('[data-for="script"]')) {
        button.hidden = kind !== 'script';
    }
    if (kind !== 'script' && (app.tab === 'options' || app.tab === 'values')) {
        app.tab = 'code';
    }
    render_toolbar();
    render_tabs();
    update_gutter();
    render_tree();
    refresh_problems();
}

/*
 * render_toolbar() — name, mode chip and buttons for the selected item
 */
function render_toolbar() {
    const kind = app.sel.kind;
    const id = app.sel.id;
    const s = current();
    const name = $('item-name');
    if (kind === 'script') {
        const meta = parse_meta($('code').value).meta;
        const mode = mode_of(s, meta);
        name.value = meta.name || '(unnamed)';
        name.readOnly = true;
        name.title = 'Change the name with @name in the header';
        $('item-chip').className = `chip ${mode}`;
        $('item-chip').textContent = mode;
    } else {
        name.value = id;
        name.readOnly = kind === 'builtin';
        name.title = kind === 'module' ? 'Module path — edit to rename or move to another folder' : 'Built-in module';
        $('item-chip').className = 'chip';
        $('item-chip').textContent = kind === 'builtin' ? 'built-in' : 'module';
    }
    const has_source = s !== null && !!s.source;
    $('enabled-wrap').hidden = kind !== 'script';
    $('enabled').checked = s !== null && !!s.enabled;
    $('export').hidden = kind !== 'script';
    $('update').hidden = !has_source;
    $('update').title = has_source ? `Fetch the latest version from ${s.source.label || s.source.url}` : '';
    $('update').textContent = is_local(s) ? '↻ Reload file' : '↻ Update';
    $('save').hidden = kind === 'builtin';
    $('delete').hidden = kind === 'builtin';
    $('delete').textContent = kind === 'module' && BUILTIN_MODULES[id] ? 'Revert to built-in' : 'Delete';
    $('override').hidden = kind !== 'builtin';
    $('override').textContent = app.modules[id] ? 'Edit override' : 'Override built-in';
}

/*
 * render_tabs() — show the selected tab's pane and fill it
 */
function render_tabs() {
    for (const button of $('tabs').querySelectorAll('button')) {
        button.classList.toggle('active', button.dataset.tab === app.tab);
    }
    for (const pane of document.querySelectorAll('[data-pane]')) {
        pane.hidden = pane.dataset.pane !== app.tab;
    }
    if (app.tab === 'options') {
        render_options();
    } else if (app.tab === 'bundle') {
        render_bundle(null);
    } else if (app.tab === 'values') {
        render_values();
    }
}

/*
 * update_gutter() — line numbers next to the editor
 */
function update_gutter() {
    const count = $('code').value.split('\n').length;
    let text = '';
    for (let i = 1; i <= count; i++) {
        text += i === 1 ? '1' : `\n${i}`;
    }
    $('gutter').textContent = text;
}

/*
 * on_editor_key(event) — Tab inserts spaces instead of leaving the editor
 */
function on_editor_key(event) {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || $('code').readOnly) {
        return;
    }
    event.preventDefault();
    document.execCommand('insertText', false, ' '.repeat(app.settings['editor.tab_size'] || 4));
}

/*
 * refresh_problems_now() — re-plan the editor's code and list errors, warnings and runtime errors
 */
async function refresh_problems_now() {
    if (app.sel === null) {
        return;
    }
    const out = [];
    if (app.sel.kind === 'script') {
        const draft = Object.assign({}, current(), { code: $('code').value });
        const p = await plan(draft, { sources: sources(), settings: app.settings });
        for (const message of p.errors) {
            out.push(h('div', { class: 'err' }, `✖ ${message}`));
        }
        for (const message of p.warnings) {
            out.push(h('div', { class: 'warn' }, `▲ ${message}`));
        }
        const sync_errors = app.status.sync_status ? app.status.sync_status.errors || {} : {};
        if (sync_errors[app.sel.id] && p.errors.length === 0) {
            out.push(h('div', { class: 'err' }, `✖ Last install: ${sync_errors[app.sel.id]}`));
        }
        const runtime_errors = app.status.script_errors ? app.status.script_errors[app.sel.id] || [] : [];
        for (const e of runtime_errors) {
            const when = new Date(e.at).toLocaleTimeString();
            out.push(h('div', { class: 'err', title: e.message }, `✖ Runtime error at ${when}: ${first_line(e.message)}`));
        }
        render_toolbar();
        if (app.tab === 'bundle') {
            render_bundle(p);
        }
    }
    $('problems').replaceChildren(...out);
}
const refresh_problems = debounce(refresh_problems_now, 250);

// ---------- save / delete / enable ----------

/*
 * save_module(code) — save the selected module, renaming it if its path changed
 */
async function save_module(code) {
    const id = app.sel.id;
    const new_name = $('item-name').value.trim();
    if (!MODULE_NAME_RE.test(new_name)) {
        toast('Module paths look like "folder/name" (letters, digits, - and _).', 'error');
        return false;
    }
    if (new_name !== id) {
        if (app.modules[new_name] && !confirm(`Replace the existing module "${new_name}"?`)) {
            return false;
        }
        await store.remove_module(id);
        delete app.modules[id];
        app.sel.id = new_name;
    }
    await store.put_module(new_name, code);
    app.modules[new_name] = { name: new_name, code: code };
    toast('Module saved — scripts using it are rebuilt');
    return true;
}

/*
 * save() — save the editor (Ctrl+S)
 */
async function save() {
    const code = $('code').value;
    if (app.sel.kind === 'script') {
        const missing = await request_permissions_for(code); // first await: keeps the user gesture
        const id = app.sel.id;
        app.scripts[id] = await store.put_script(Object.assign({}, app.scripts[id], { code: code }));
        if (missing.length > 0) {
            toast(`Saved, but without permission for: ${missing.join(', ')}. Those browser APIs will fail.`, 'error');
        } else {
            toast('Saved');
        }
    } else if (!(await save_module(code))) {
        return;
    }
    app.dirty = false;
    $('dirty').hidden = true;
    render_tree();
    render_toolbar();
}

/*
 * delete_selected() — delete the selected script or module (after asking)
 */
async function delete_selected() {
    const kind = app.sel.kind;
    const id = app.sel.id;
    if (kind === 'script') {
        if (!confirm(`Delete "${parse_meta(app.scripts[id].code).meta.name}" and its stored values?`)) {
            return;
        }
        await store.remove_script(id);
        delete app.scripts[id];
    } else {
        let users = 0;
        for (const sid of Object.keys(app.scripts)) {
            if (script_uses(app.scripts[sid], id)) {
                users++;
            }
        }
        let message = `Delete module "${id}"?`;
        if (BUILTIN_MODULES[id]) {
            message = `Drop your override of "${id}" and go back to the built-in?`;
        } else if (users > 0) {
            message += ` ${users} script(s) use it and will stop working.`;
        }
        if (!confirm(message)) {
            return;
        }
        await store.remove_module(id);
        delete app.modules[id];
    }
    app.dirty = false;
    app.sel = null;
    $('item').hidden = true;
    $('empty').hidden = false;
    history.replaceState(null, '', '?');
    render_tree();
}

/*
 * override_builtin() — copy a built-in module into "My modules" under the same name
 */
async function override_builtin() {
    const id = app.sel.id;
    if (!app.modules[id]) {
        const code = await load_text(BUILTIN_MODULES[id]);
        await store.put_module(id, code);
        app.modules[id] = { name: id, code: code };
    }
    select('module', id, true);
}

/*
 * toggle_enabled() — the "Enabled" switch
 */
async function toggle_enabled() {
    const on = $('enabled').checked;
    if (on) {
        await request_permissions_for($('code').value);
    }
    app.scripts[app.sel.id] = await store.patch_script(app.sel.id, { enabled: on });
    render_tree();
}

/*
 * render_moss_enabled() — the "switched off" banner (the switch itself is in the popup)
 */
function render_moss_enabled() {
    $('off-banner').hidden = app.enabled;
}

// ---------- new scripts and modules ----------

/*
 * template(site) -> code of a new script, from the "New scripts" settings
 */
function template(site) {
    const s = app.settings;
    const lines = [
        ['name', 'New script'], ['namespace', s['new.namespace']], ['version', '0.1.0'], ['description', 'What does it do?'],
    ];
    if (s['new.folder']) {
        lines.push(['folder', s['new.folder']]);
    }
    if (s['new.sandbox'] !== 'extension') {
        lines.push(['match', site ? `${site}/*` : 'https://example.com/*']);
    }
    if (s['new.sandbox'] !== 'isolated') {
        lines.push(['sandbox', s['new.sandbox']]);
    }
    if (s['new.run_at'] !== 'document-idle') {
        lines.push(['run-at', s['new.run_at']]);
    }
    lines.push(['strict', '']);
    let toast_alias = null;
    for (const use of s['new.uses']) {
        lines.push(['use', use]);
        const m = /^moss\/ui\/toast as (\w+)$/.exec(use);
        if (m !== null) {
            toast_alias = m[1];
        }
    }
    let header = '';
    for (const line of lines) {
        header += `// @${line[0].padEnd(12)} ${line[1]}`.trimEnd() + '\n';
    }
    const body = toast_alias !== null ? `${toast_alias}('Hello from Moss 👋');\n` : 'console.log(\'Hello from Moss 👋\');\n';
    return `// ==UserScript==\n${header}// ==/UserScript==\n\n${body}`;
}

/*
 * module_template(name) -> code of a new module
 */
function module_template(name) {
    const parts = name.split('/');
    const alias = slugify(parts[parts.length - 1]).replace(/-/g, '_');
    return `'use strict';
/*
 * ${name}
 * Use it from a script with:  // @use ${name} as ${alias}
 * Modules see: module, exports, require, api (the calling script's GM functions).
 */

/*
 * hello(who) -> a greeting for who
 */
function hello(who) {
    return 'Hello, ' + who;
}

exports.hello = hello;
`;
}

/*
 * create_script(code) -> the new struct script, opened in the editor
 */
async function create_script(code) {
    const s = await store.put_script({ id: store.new_id(), code: code, enabled: false, created_at: Date.now() });
    app.scripts[s.id] = s;
    await select('script', s.id, true);
    return s;
}

/*
 * new_module() — ask for a path and create a module there
 */
async function new_module() {
    const name = prompt('Module path (folders allowed), e.g. "utils/dates" or "ui/my_panel":', 'utils/');
    if (!name) {
        return;
    }
    if (!MODULE_NAME_RE.test(name)) {
        toast('Use letters, digits, - and _, separated by "/".', 'error');
        return;
    }
    if (app.modules[name]) {
        select('module', name);
        return;
    }
    if (BUILTIN_MODULES[name] && !confirm(`"${name}" is a built-in. Create an override?`)) {
        return;
    }
    const code = module_template(name);
    await store.put_module(name, code);
    app.modules[name] = { name: name, code: code };
    select('module', name, true);
}

// ---------- import (GitHub file / folder / repo, gist, URL, local file) ----------

/*
 * struct import_item { url, label, path, code, meta, error, checked }
 */
const importer = { items: [] };

/*
 * every_select(value, on_change) -> a <select> of update intervals
 */
function every_select(value, on_change) {
    const options = [];
    for (const option of EVERY_OPTIONS) {
        options.push(h('option', { value: option.value, selected: option.value === Number(value) }, option.label));
    }
    return h('select', {
        on_change: function (event) {
            on_change(Number(event.target.value));
        },
    }, options);
}

/*
 * open_import() — reset and show the import dialog
 */
function open_import() {
    importer.items = [];
    $('im-url').value = '';
    $('im-results').replaceChildren();
    $('im-error').textContent = '';
    $('im-go').disabled = true;
    $('im-update-row').hidden = true;
    $('im-auto').checked = app.settings['update.auto_by_default'];
    const select_el = every_select(app.settings['update.every'], function () {});
    select_el.id = 'im-every';
    $('im-every').replaceWith(select_el);
    $('import-dialog').showModal();
    $('im-url').focus();
}

/*
 * pick_row(item) -> one row of the import list
 */
function pick_row(item) {
    let title = h('strong', null, item.path || item.label);
    if (item.meta) {
        title = h('strong', null, item.meta.name, ' ',
            h('span', { class: 'hint' }, `v${item.meta.version}`), ' ',
            h('span', { class: `chip ${item.meta.sandbox}` }, item.meta.sandbox));
    }
    return h('label', { class: `pick${item.code ? '' : ' disabled'}` },
        h('input', {
            type: 'checkbox',
            checked: item.checked,
            disabled: !item.code,
            on_change: function (event) {
                item.checked = event.target.checked;
                render_picks();
            },
        }),
        h('div', { class: 'what' },
            title,
            item.meta && item.meta.description ? h('div', null, item.meta.description) : null,
            item.error ? h('div', { class: 'error' }, item.error) : null,
            h('div', { class: 'path' }, item.path || item.label)));
}

/*
 * render_picks() — redraw the import list and its buttons
 */
function render_picks() {
    let picked = 0;
    let any_code = false;
    const rows = [];
    for (const item of importer.items) {
        if (item.checked) {
            picked++;
        }
        if (item.code) {
            any_code = true;
        }
        rows.push(pick_row(item));
    }
    $('im-go').disabled = picked === 0;
    $('im-go').textContent = picked > 1 ? `Import ${picked} scripts` : 'Import';
    $('im-update-row').hidden = !any_code;
    $('im-results').replaceChildren(h('div', { class: 'pick-list' }, rows));
}

/*
 * already_imported(url) -> true if a script already tracks this source URL
 */
function already_imported(url) {
    for (const id of Object.keys(app.scripts)) {
        const src = app.scripts[id].source;
        if (src && src.url === url) {
            return true;
        }
    }
    return false;
}

/*
 * fetch_item(file, token) -> struct import_item for one candidate file
 */
async function fetch_item(file, token) {
    try {
        const code = await fetch_text(file.url, { token: token });
        const parsed = parse_meta(code);
        for (const error of parsed.errors) {
            if (error.startsWith('Missing')) {
                return Object.assign({}, file, { error: 'Not a userscript (no // ==UserScript== header).' });
            }
        }
        const dup = already_imported(file.url);
        return Object.assign({}, file, {
            code: code,
            meta: parsed.meta,
            checked: !dup,
            error: dup ? 'Already imported — use ↻ Update on it instead.' : null,
        });
    } catch (e) {
        return Object.assign({}, file, { error: e.message });
    }
}

/*
 * lookup() — resolve the pasted link into a list of importable scripts
 */
async function lookup() {
    $('im-error').textContent = '';
    $('im-results').replaceChildren(h('p', { class: 'hint' }, 'Looking…'));
    const token = app.settings['github.token'];
    try {
        const link = parse_source_url($('im-url').value);
        let files = [];
        if (link.type === 'repo') {
            for (const f of await list_repo_scripts(link, { token: token })) {
                files.push(Object.assign({}, f, { label: `${link.owner}/${link.repo}/${f.path}` }));
            }
            if (files.length === 0) {
                throw new Error(`No .js files in ${link.owner}/${link.repo}${link.dir ? `/${link.dir}` : ''}.`);
            }
            if (files.length > 60) {
                throw new Error(`${files.length} .js files found — link to a folder (…/tree/main/folder) to narrow it down.`);
            }
        } else {
            files = [{ url: link.url, label: link.label }];
        }
        const pending = [];
        for (const f of files) {
            pending.push(fetch_item(f, token));
        }
        importer.items = await Promise.all(pending);
        importer.items.sort(function (a, b) {
            return Number(!!b.code) - Number(!!a.code);
        });
        render_picks();
    } catch (e) {
        $('im-results').replaceChildren();
        $('im-error').textContent = e.message;
    }
}

/*
 * import_picked() — store every ticked script, linked to its source
 */
async function import_picked() {
    const picked = [];
    for (const item of importer.items) {
        if (item.checked && item.code) {
            picked.push(item);
        }
    }
    const auto = $('im-auto').checked;
    const every = Number($('im-every').value);
    let last = null;
    for (const item of picked) {
        const source = Object.assign(await source_create(item.url, item.label, item.code, app.settings), { auto: auto, every: every });
        last = await store.put_script({ id: store.new_id(), code: item.code, enabled: false, source: source, created_at: Date.now() });
        app.scripts[last.id] = last;
        await store.record_update(last.id, { status: 'current', error: null });
    }
    $('import-dialog').close();
    if (last !== null) {
        await select('script', last.id, true);
    }
    const what = picked.length === 1 ? `"${picked[0].meta.name}"` : `${picked.length} scripts`;
    toast(`Imported ${what} — disabled until you review and enable ${picked.length === 1 ? 'it' : 'them'}.`);
}

/*
 * import_code(code) — add a script from a local file
 */
async function import_code(code) {
    const parsed = parse_meta(code);
    for (const error of parsed.errors) {
        if (error.startsWith('Missing')) {
            toast('That file has no "// ==UserScript==" header.', 'error');
            return;
        }
    }
    await create_script(code);
    toast(`Imported "${parsed.meta.name}" (disabled — review it, then enable)`);
}

// ---------- scripts linked to a local file ----------

/*
 * is_local(s) -> true if the script is linked to a file on this computer
 */
function is_local(s) {
    return s !== null && !!s.source && s.source.kind === 'local';
}

/*
 * apply_local_text(s, text) — store the file's text as the script's code
 */
async function apply_local_text(s, text) {
    const source = Object.assign({}, s.source, { hash: await sha256(text), updated_at: Date.now() });
    app.own_write = text;
    app.scripts[s.id] = await store.put_script(Object.assign({}, s, { code: text, source: source }));
    if (current() !== null && current().id === s.id) {
        await select('script', s.id, true);
    }
}

/*
 * link_local_file() — link the selected script to a file chosen with the file picker
 */
async function link_local_file() {
    let handle;
    try {
        handle = await pick_file(); // first await: keeps the user gesture
    } catch (e) {
        return; // picker cancelled
    }
    const s = current();
    const file = await read_file(handle);
    if (!confirm(`Replace "${parse_meta(s.code).meta.name}" with the contents of ${handle.name}? From now on it reloads whenever the file is saved (while a Moss page is open).`)) {
        return;
    }
    await save_handle(s.id, handle);
    const source = { kind: 'local', url: `local:${handle.name}`, label: `${handle.name} (file on this computer)`, hash: '', auto: true, every: 0 };
    app.scripts[s.id] = Object.assign({}, s, { source: source });
    app.local[s.id] = { modified: file.modified, error: null };
    await apply_local_text(app.scripts[s.id], file.text);
    toast(`Linked to ${handle.name} — save the file to reload the script`);
}

/*
 * reload_local(s, ask) -> true if the file was read; ask: allowed to show the browser's
 * permission prompt (only from a click)
 */
async function reload_local(s, ask) {
    const handle = await load_handle(s.id);
    if (handle === undefined) {
        app.local[s.id] = { modified: 0, error: 'The file link was lost — link the file again.' };
        return false;
    }
    if (!(await has_access(handle)) && !(ask && (await reconnect(handle)))) {
        app.local[s.id] = { modified: 0, error: 'The browser needs your OK to read the file again — click Reconnect.' };
        return false;
    }
    const known = app.local[s.id];
    const file = await read_file(handle);
    app.local[s.id] = { modified: file.modified, error: null };
    if (known && known.modified === file.modified && file.text === s.code) {
        return true;
    }
    if (file.text === s.code) {
        return true;
    }
    if (current() !== null && current().id === s.id && app.dirty) {
        toast(`${handle.name} changed, but you have unsaved edits here — save or discard them to reload.`, 'error');
        return true;
    }
    await apply_local_text(s, file.text);
    toast(`Reloaded "${parse_meta(file.text).meta.name}" from ${handle.name}`);
    return true;
}

let watching = false;

/*
 * watch_local_files() — reload every linked script whose file changed (runs every 1.5 s)
 */
async function watch_local_files() {
    if (watching) {
        return;
    }
    watching = true;
    try {
        for (const id of Object.keys(app.scripts)) {
            const s = app.scripts[id];
            if (is_local(s)) {
                await reload_local(s, false);
            }
        }
    } catch (e) {
        console.error('Moss: watching local files failed', e);
    } finally {
        watching = false;
    }
}

// ---------- updating from the source ----------

/*
 * update_from_source(s) — "↻ Update": fetch the latest version and apply it
 */
async function update_from_source(s) {
    if (app.dirty && !confirm('You have unsaved changes in the editor. Updating replaces them. Continue?')) {
        return;
    }
    if (is_local(s)) {
        app.dirty = false;
        if (await reload_local(s, true)) {
            toast('Read the file again');
        } else {
            toast(app.local[s.id].error, 'error');
        }
        if (app.tab === 'options') {
            render_options();
        }
        return;
    }
    $('update').disabled = true;
    try {
        const check = await check_for_update(s, { settings: app.settings, manual: true });
        if (check.status === 'current') {
            await store.record_update(s.id, { status: 'current', error: null });
            toast('Already up to date');
            return;
        }
        if (check.status === 'local-changes') {
            if (!confirm('You changed this script in Moss since it was imported. Replace your changes with the latest version from the source?')) {
                return;
            }
        }
        const before = parse_meta(s.code).meta.version;
        app.own_write = check.code; // not an outside change: don't announce it twice
        app.scripts[s.id] = await store.put_script(apply_update(s, check));
        await store.record_update(s.id, { status: 'updated', version: check.version, updated_at: Date.now(), error: null });
        app.dirty = false;
        await select('script', s.id, true);
        toast(before === check.version ? `Updated to the latest code (still v${check.version})` : `Updated v${before} → v${check.version}`);
        // A new @grant may need a permission; Save asks for it.
        const missing = await missing_permissions(check.code);
        if (missing.length > 0) {
            toast(`The new version needs the ${missing.join(', ')} permission — click Save to grant it.`, 'error');
        }
    } catch (e) {
        await store.record_update(s.id, { status: 'error', error: e.message });
        toast(`Update failed: ${e.message}`, 'error');
    } finally {
        $('update').disabled = false;
    }
}

/*
 * check_all() — "Check all imported scripts for updates now"
 */
async function check_all() {
    $('check-all').disabled = true;
    $('check-all-result').textContent = 'Checking…';
    let reply;
    try {
        reply = await chrome.runtime.sendMessage({ type: 'updates.run' });
    } catch (e) {
        reply = { ok: false, error: e.message };
    }
    $('check-all').disabled = false;
    if (!reply || !reply.ok) {
        $('check-all-result').textContent = (reply && reply.error) || 'Failed';
        return;
    }
    const r = reply.value;
    if (r.checked === 0) {
        $('check-all-result').textContent = 'No imported scripts to check.';
        return;
    }
    let text = `Checked ${r.checked}. `;
    text += r.updated.length > 0 ? `Updated: ${r.updated.join(', ')}.` : 'Nothing new.';
    if (r.errors.length > 0) {
        text += ` Problems: ${r.errors.join('; ')}`;
    }
    $('check-all-result').textContent = text;
}

// ---------- options pane (per-script overrides) ----------

/*
 * schema_input(def, value, on_change) -> an input for one struct setting
 */
function schema_input(def, value, on_change) {
    if (def.type === 'checkbox') {
        return h('input', {
            type: 'checkbox', class: 'switch', checked: !!value,
            on_change: function (event) {
                on_change(event.target.checked);
            },
        });
    }
    if (def.type === 'select') {
        const options = [];
        for (const option of def.options) {
            if (typeof option === 'object') {
                options.push(option);
            } else {
                options.push({ value: option, label: option === '' ? '— from header —' : option });
            }
        }
        const option_nodes = [];
        for (const option of options) {
            option_nodes.push(h('option', { value: option.value, selected: String(option.value) === String(value_or(value, '')) }, option.label));
        }
        return h('select', {
            on_change: function (event) {
                for (const option of options) {
                    if (String(option.value) === event.target.value) {
                        on_change(option.value);
                    }
                }
            },
        }, option_nodes);
    }
    if (def.type === 'list') {
        return h('textarea', {
            rows: 3, placeholder: 'One per line',
            on_change: function (event) {
                const items = [];
                for (const line of event.target.value.split('\n')) {
                    if (line.trim() !== '') {
                        items.push(line.trim());
                    }
                }
                on_change(items);
            },
        }, (value || []).join('\n'));
    }
    if (def.type === 'number') {
        return h('input', {
            type: 'number', value: value_or(value, value_or(def.default, '')),
            on_change: function (event) {
                on_change(event.target.value === '' ? null : Number(event.target.value));
            },
        });
    }
    if (def.type === 'password') {
        return h('input', {
            type: 'password', value: value_or(value, ''), autocomplete: 'off',
            on_change: function (event) {
                on_change(event.target.value.trim());
            },
        });
    }
    return h('input', {
        type: 'text', value: value_or(value, ''),
        on_change: function (event) {
            on_change(event.target.value);
        },
    });
}

/*
 * patch_source(change) — update (or with null, remove) the selected script's source
 */
async function patch_source(change) {
    const s = current();
    const source = change === null ? null : Object.assign({}, s.source, change);
    app.scripts[s.id] = await store.patch_script(s.id, { source: source });
    toast('Saved');
    render_options();
    render_toolbar();
}

/*
 * link_source(input) — link the selected script to a GitHub file or URL
 */
async function link_source(input) {
    try {
        const link = parse_source_url(input.value);
        if (link.type !== 'file') {
            throw new Error('Link to a single file, not a repository or folder.');
        }
        // The current code counts as "fetched", so local edits made from now on are detected.
        await patch_source(await source_create(link.url, link.label, current().code, app.settings));
    } catch (e) {
        toast(e.message, 'error');
    }
}

/*
 * update_status_text(u) -> one line describing the last update check
 */
function update_status_text(u) {
    if (!u) {
        return 'never checked';
    }
    const words = {
        'current': 'up to date',
        'updated': `updated${u.version ? ` to v${u.version}` : ''}`,
        'local-changes': 'newer version available, but you edited this script here — use ↻ Update',
        'not-newer': 'source changed but @version did not go up',
        'error': 'failed',
    };
    const what = value_or(words[u.status], u.status);
    return `${what} · checked ${new Date(u.checked_at).toLocaleString()}`;
}

/*
 * source_box(s) -> the "Source" box at the top of a script's Options tab
 */
function source_box(s) {
    const src = s.source;
    if (!src) {
        const input = h('input', { type: 'text', placeholder: 'https://github.com/you/repo/blob/main/script.js' });
        return h('div', { class: 'source-box' },
            h('h3', null, 'Source'),
            h('p', { class: 'hint' }, 'Not linked to a source. Link it to a GitHub file or URL to update it from there.'),
            h('div', { class: 'row' }, input, h('button', {
                class: 'btn',
                on_click: function () {
                    link_source(input);
                },
            }, 'Link')),
            h('div', { class: 'row' },
                h('button', { class: 'btn', on_click: link_local_file }, 'Link a local file…'),
                h('span', { class: 'hint' }, 'Live-reload while you develop: the script follows the file every time you save it.')));
    }
    if (is_local(s)) {
        const info = app.local[s.id];
        const status = info && info.error ? info.error
            : `reloads when the file is saved (while a Moss page is open)${info && info.modified ? ` · file saved ${new Date(info.modified).toLocaleString()}` : ''}`;
        return h('div', { class: 'source-box' },
            h('h3', null, 'Source'),
            h('div', { class: 'row' }, h('code', null, src.label)),
            h('div', { class: 'row' },
                h('button', {
                    class: 'btn',
                    on_click: function () {
                        update_from_source(current());
                    },
                }, info && info.error ? 'Reconnect' : '↻ Read the file now'),
                h('button', {
                    class: 'btn ghost',
                    on_click: async function () {
                        if (confirm('Unlink this script from the file? The current code stays.')) {
                            await remove_handle(s.id);
                            delete app.local[s.id];
                            patch_source(null);
                        }
                    },
                }, 'Unlink')),
            h('div', { class: info && info.error ? 'error' : 'hint' }, status));
    }
    const u = app.updates[s.id];
    const status = update_status_text(u);
    return h('div', { class: 'source-box' },
        h('h3', null, 'Source'),
        h('div', { class: 'row' }, h('code', null, src.label || src.url)),
        h('div', { class: 'row' },
            h('label', { class: 'enabled' }, h('input', {
                type: 'checkbox', class: 'switch', checked: !!src.auto,
                on_change: function (event) {
                    patch_source({ auto: event.target.checked });
                },
            }), 'Auto-update'),
            every_select(src.every || app.settings['update.every'], function (every) {
                patch_source({ every: every });
            }),
            h('button', {
                class: 'btn',
                on_click: function () {
                    update_from_source(current());
                },
            }, '↻ Update now'),
            h('button', {
                class: 'btn ghost',
                on_click: function () {
                    if (confirm('Unlink this script from its source? It will no longer update.')) {
                        patch_source(null);
                    }
                },
            }, 'Unlink')),
        h('div', { class: u && u.error ? 'error' : 'hint' }, u && u.error ? `${status} — ${u.error}` : status));
}

/*
 * set_option(key, value) — store one per-script override (empty = back to the header)
 */
async function set_option(key, value) {
    const s = current();
    const next = Object.assign({}, s.options);
    const empty = value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    if (empty) {
        delete next[key];
    } else {
        next[key] = value;
    }
    app.scripts[s.id] = await store.patch_script(s.id, { options: next });
    toast('Option saved');
    render_tree();
    refresh_problems();
}

/*
 * feature_table(opts, used) -> the auto/include/exclude grid for every feature
 */
function feature_table(opts, used) {
    const cells = [];
    const forced = opts.features || {};
    for (const name of Object.keys(FEATURES)) {
        const choice_nodes = [];
        for (const choice of ['auto', 'include', 'exclude']) {
            choice_nodes.push(h('option', { value: choice, selected: value_or(forced[name], 'auto') === choice }, choice));
        }
        cells.push(
            h('strong', null, FEATURES[name].label),
            h('select', {
                on_change: function (event) {
                    const next = Object.assign({}, (current().options || {}).features);
                    if (event.target.value === 'auto') {
                        delete next[name];
                    } else {
                        next[name] = event.target.value;
                    }
                    set_option('features', Object.keys(next).length > 0 ? next : null);
                },
            }, choice_nodes),
            h('span', { class: 'hint' }, used[name] ? `included — ${used[name]}` : 'not included'));
    }
    return h('div', { class: 'feature-table' }, cells);
}

/*
 * render_options() — fill the Options tab
 */
async function render_options() {
    const s = current();
    if (s === null) {
        return;
    }
    const p = await plan(Object.assign({}, s, { code: $('code').value }), { sources: sources(), settings: app.settings });
    const used = {};
    for (const f of p.features) {
        used[f.name] = f.reason;
    }
    const opts = s.options || {};
    const rows = [];
    for (const def of SCRIPT_OPTIONS) {
        let input;
        if (def.type === 'features') {
            input = feature_table(opts, used);
        } else {
            input = schema_input(def, opts[def.key], function (value) {
                set_option(def.key, value);
            });
        }
        rows.push(h('label', null, def.label), h('div', null, input, def.help ? h('div', { class: 'hint' }, def.help) : null));
    }
    $('options').replaceChildren(...rows);
    $('options-source').replaceChildren(source_box(current()));
}

// ---------- bundle inspector ----------

/*
 * render_module_bundle() — Bundle tab for a module: what it requires, pulls in, and who uses it
 */
function render_module_bundle() {
    const src = $('code').value;
    const deps = [];
    for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        deps.push({ name: m[1], reason: '' });
    }
    const features = [];
    for (const name of Object.keys(FEATURES)) {
        if (FEATURES[name].detect.test(src)) {
            features.push(name);
        }
    }
    const users = [];
    for (const id of Object.keys(app.scripts)) {
        if (script_uses(app.scripts[id], app.sel.id)) {
            users.push(h('li', null, parse_meta(app.scripts[id].code).meta.name));
        }
    }
    $('bundle').replaceChildren(h('div', { class: 'bundle' },
        h('h3', null, 'Requires'), reason_list(deps, 'No other modules.'),
        h('h3', null, 'Pulls in runtime features'),
        h('p', null, features.length > 0 ? features.join(', ') : h('span', { class: 'hint' }, 'none — it adds nothing beyond its own code')),
        h('h3', null, 'Used by'),
        users.length > 0 ? h('ul', { class: 'reasons' }, users) : h('p', { class: 'hint' }, 'No scripts yet.'),
        h('h3', null, 'Size'), h('p', null, format_size(byte_size(src)))));
}

/*
 * how_it_runs(p) -> the definition list at the top of a script's Bundle tab
 */
function how_it_runs(p) {
    const bridges = {
        port: 'port to the extension',
        window: 'sandboxed iframe in the background runner',
        none: 'none (no privileged features used)',
    };
    const rows = [
        h('dt', null, 'Sandbox'), h('dd', null, h('span', { class: `chip ${p.mode}` }, p.mode)),
        h('dt', null, 'Bridge'), h('dd', null, value_or(bridges[p.transport], p.transport)),
        h('dt', null, 'Injection'), h('dd', null, p.inject),
        h('dt', null, 'Strict mode'), h('dd', null, p.strict ? 'on' : 'off (add // @strict to turn it on)'),
    ];
    const t = p.targets;
    if (t === null) {
        rows.push(h('dt', null, 'Where'), h('dd', null, 'background, no page'));
        return h('dl', { class: 'kv' }, rows);
    }
    rows.push(h('dt', null, 'Matches'), h('dd', null, t.matches.join(', ')));
    if (t.include_globs.length > 0) {
        rows.push(h('dt', null, 'Include globs'), h('dd', null, t.include_globs.join(', ')));
    }
    if (t.exclude_matches.length > 0 || t.exclude_globs.length > 0) {
        rows.push(h('dt', null, 'Excludes'), h('dd', null, t.exclude_matches.concat(t.exclude_globs).join(', ')));
    }
    if (t.filter !== null) {
        rows.push(h('dt', null, 'URL filter'), h('dd', null, 'checked at runtime (regex or mixed @match/@include rules)'));
    }
    rows.push(h('dt', null, 'Run at'), h('dd', null, t.run_at.replace('_', '-')));
    rows.push(h('dt', null, 'Frames'), h('dd', null, t.all_frames ? 'all frames' : 'top frame only'));
    return h('dl', { class: 'kv' }, rows);
}

/*
 * render_bundle(given) — fill the Bundle tab (given: a plan already computed, or null)
 */
async function render_bundle(given) {
    if (app.sel.kind !== 'script') {
        render_module_bundle();
        return;
    }
    const draft = Object.assign({}, current(), { code: $('code').value });
    const p = given !== null ? given : await plan(draft, { sources: sources(), settings: app.settings });

    /*
     * show_generated() — build the bundle and show its code
     */
    async function show_generated() {
        try {
            const code = await build(p, { sources: sources(), script: draft, token: '•••', settings: app.settings });
            $('generated').replaceChildren(h('p', { class: 'hint' }, `${format_size(byte_size(code))} injected`), h('pre', { class: 'generated' }, code));
        } catch (e) {
            $('generated').replaceChildren(h('p', { class: 'error' }, e.message));
        }
    }

    const features = [];
    for (const f of p.features) {
        features.push(h('li', null, h('strong', null, FEATURES[f.name].label), h('span', { class: 'why' }, f.reason)));
    }
    const modules = [];
    for (const m of p.modules) {
        modules.push(h('li', null, h('code', null, m.name), h('span', { class: 'size' }, format_size(byte_size(m.src)))));
    }
    $('bundle').replaceChildren(h('div', { class: 'bundle' },
        h('h3', null, 'How it runs'),
        how_it_runs(p),
        h('h3', null, 'Runtime features'),
        features.length > 0 ? h('ul', { class: 'reasons' }, features) : h('p', { class: 'hint' }, 'none'),
        h('h3', null, 'Modules'),
        modules.length > 0 ? h('ul', { class: 'reasons' }, modules) : h('p', { class: 'hint' }, 'none'),
        h('h3', null, 'Browser permissions'),
        reason_list(p.permissions.concat(p.host_permissions)),
        p.errors.length > 0 ? [h('h3', null, 'Errors'), h('p', { class: 'error' }, p.errors.join('\n'))] : null,
        h('div', { class: 'row' }, h('button', { class: 'btn', on_click: show_generated }, 'Show generated code')),
        h('div', { id: 'generated' })));
}

// ---------- values pane ----------

/*
 * render_values() — show the selected script's GM values as JSON
 */
async function render_values() {
    $('values').value = JSON.stringify(await store.load_values(app.sel.id), null, 2);
}

/*
 * save_values() — store the edited JSON
 */
async function save_values() {
    try {
        await store.save_values(app.sel.id, JSON.parse($('values').value || '{}'));
        toast('Values saved — open pages see them after a reload');
    } catch (e) {
        toast(`Not valid JSON: ${e.message}`, 'error');
    }
}

/*
 * clear_values() — forget every stored value of the script
 */
async function clear_values() {
    if (!confirm('Clear every stored value of this script?')) {
        return;
    }
    await store.save_values(app.sel.id, {});
    render_values();
}

// ---------- settings view ----------

/*
 * save_setting(key, value) — store one global setting
 */
async function save_setting(key, value) {
    app.settings = Object.assign({}, app.settings);
    app.settings[key] = value;
    await store.save_settings(app.settings);
    apply_appearance();
    toast('Setting saved');
}

/*
 * render_settings() — fill the Settings view from the SETTINGS schema
 */
function render_settings() {
    const sections = new Map();
    for (const def of SETTINGS) {
        if (!sections.has(def.section)) {
            sections.set(def.section, []);
        }
        sections.get(def.section).push(def);
    }
    const nodes = [];
    for (const [name, defs] of sections) {
        const rows = [];
        for (const def of defs) {
            const input = schema_input(def, app.settings[def.key], function (value) {
                save_setting(def.key, value_or(value, def.default));
            });
            rows.push(h('label', null, def.label), h('div', null, input, def.help ? h('div', { class: 'hint' }, def.help) : null));
        }
        nodes.push(h('section', { class: 'settings-section' }, h('h2', null, name), h('div', { class: 'form-grid' }, rows)));
    }
    $('settings').replaceChildren(...nodes);
}

/*
 * reset_settings() — back to the defaults
 */
async function reset_settings() {
    if (!confirm('Reset all settings to their defaults? Scripts and modules are not touched.')) {
        return;
    }
    app.settings = resolve_settings({});
    await store.save_settings({});
    apply_appearance();
    render_settings();
}

/*
 * export_backup() — download scripts, modules, settings and values as JSON
 */
async function export_backup() {
    const all = await chrome.storage.local.get(null);
    const values = {};
    for (const key of Object.keys(all)) {
        if (key.startsWith('values:')) {
            values[key] = all[key];
        }
    }
    const data = {
        moss: SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        scripts: all.scripts || {},
        modules: all.modules || {},
        settings: all.settings || {},
        updates: all.updates || {},
        values: values,
    };
    const name = `moss-backup-${new Date().toISOString().slice(0, 10)}.json`;
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);
}

/*
 * import_backup(file) — merge a backup into storage (older backups are migrated first)
 */
async function import_backup(file) {
    try {
        let data = JSON.parse(await file.text());
        if (typeof data.moss !== 'number') {
            throw new Error('not a Moss backup');
        }
        if (data.moss < SCHEMA_VERSION) {
            data = migrate_state(Object.assign({}, data, { schema_version: data.moss })).data;
        }
        const script_count = Object.keys(data.scripts || {}).length;
        const module_count = Object.keys(data.modules || {}).length;
        if (!confirm(`Restore ${script_count} script(s) and ${module_count} module(s)? Items with the same id or name are replaced; everything else is kept.`)) {
            return;
        }
        const scripts = await store.load_scripts();
        const modules = await store.load_modules();
        const updates = await store.load_updates();
        await chrome.storage.local.set(Object.assign({
            scripts: Object.assign(scripts, data.scripts),
            modules: Object.assign(modules, data.modules),
            updates: Object.assign(updates, data.updates),
            settings: Object.assign({}, app.settings, data.settings),
        }, data.values));
        await load_all();
        render_tree();
        render_settings();
        toast(`Restored ${script_count} script(s)`);
    } catch (e) {
        toast(`Restore failed: ${e.message}`, 'error');
    }
}

// ---------- export dialog ----------

/*
 * struct exporter_state { features: { [name]: 'exclude' }, manifest_edited: boolean, result: struct export_result | null }
 */
const exporter = { features: {}, manifest_edited: false, result: null };

/*
 * export_feature_rows(p) -> one checkbox per feature that is (or was) in the export
 */
function export_feature_rows(p) {
    const reasons = {};
    for (const f of p.features) {
        reasons[f.name] = f.reason;
    }
    const rows = [];
    for (const name of Object.keys(FEATURES)) {
        const kept = reasons[name] !== undefined;
        if (!kept && exporter.features[name] !== 'exclude') {
            continue;
        }
        rows.push(h('label', { class: 'check' },
            h('input', {
                type: 'checkbox', checked: kept,
                on_change: function (event) {
                    if (event.target.checked) {
                        delete exporter.features[name];
                    } else {
                        exporter.features[name] = 'exclude';
                    }
                    refresh_export();
                },
            }),
            h('span', null, h('strong', null, FEATURES[name].label), ' ', h('span', { class: 'hint' }, kept ? reasons[name] : 'excluded'))));
    }
    if (rows.length === 0) {
        rows.push(h('p', { class: 'hint' }, 'None. The script needs no runtime features.'));
    }
    return rows;
}

/*
 * refresh_export() — rebuild the export preview from the dialog's choices
 */
async function refresh_export() {
    const draft = Object.assign({}, current(), { code: $('code').value });
    const choices = {
        name: $('ex-name').value.trim() || undefined,
        version: $('ex-version').value.trim() || undefined,
        description: $('ex-description').value,
        features: exporter.features,
        include_source: $('ex-source').checked,
        include_readme: $('ex-readme').checked,
    };
    if (exporter.manifest_edited) {
        try {
            choices.manifest = JSON.parse($('ex-manifest').value);
        } catch (e) {
            $('ex-error').textContent = `manifest.json: ${e.message}`;
            return;
        }
    }
    $('ex-error').textContent = '';
    try {
        const result = await export_extension(draft, { sources: sources(), settings: app.settings, choices: choices });
        exporter.result = result;
        const p = result.plan;
        $('ex-features').replaceChildren(...export_feature_rows(p));
        $('ex-permissions').replaceChildren(reason_list(p.permissions.concat(p.host_permissions), 'None.'));
        let total = 0;
        const rows = [];
        for (const f of result.files) {
            const size = byte_size(f.content);
            total += size;
            rows.push(h('li', null, h('code', null, f.path), h('span', { class: 'why' }, f.reason), h('span', { class: 'size' }, format_size(size))));
        }
        $('ex-size').textContent = `— ${result.files.length} files, ${format_size(total)}`;
        $('ex-files').replaceChildren(...rows);
        if (!exporter.manifest_edited) {
            $('ex-manifest').value = JSON.stringify(result.manifest, null, 2);
        }
    } catch (e) {
        exporter.result = null;
        $('ex-error').textContent = e.message;
    }
}

/*
 * open_export() — show the export dialog for the selected script
 */
async function open_export() {
    if (app.dirty && !confirm('Export uses the code in the editor, including unsaved changes. Continue?')) {
        return;
    }
    const meta = parse_meta($('code').value).meta;
    const options = current().options || {};
    exporter.features = Object.assign({}, options.features);
    exporter.manifest_edited = false;
    $('ex-name').value = meta.name;
    $('ex-version').value = meta.version;
    $('ex-description').value = meta.description;
    $('ex-source').checked = app.settings['export.include_source'];
    $('ex-readme').checked = app.settings['export.include_readme'];
    $('ex-manifest-wrap').hidden = !app.settings['export.review_manifest'];
    $('export-dialog').showModal();
    await refresh_export();
}

/*
 * download_export(event) — zip the previewed files and download them
 */
function download_export(event) {
    event.preventDefault();
    if (exporter.result === null) {
        return;
    }
    const name = slugify(exporter.result.manifest.name);
    const files = [];
    for (const f of exporter.result.files) {
        files.push({ path: `${name}/${f.path}`, content: f.content });
    }
    download(new Blob([zip(files)], { type: 'application/zip' }), `${name}-extension.zip`);
    $('export-dialog').close();
    toast(`Exported ${name}-extension.zip`);
}

// ---------- live updates from other pages ----------

/*
 * on_storage_change(changes, area) — keep the page in step with the popup, the service
 * worker and auto-updates
 */
async function on_storage_change(changes, area) {
    if (area === 'session' && (changes.sync_status || changes.script_errors)) {
        if (changes.sync_status) {
            app.status.sync_status = changes.sync_status.newValue;
        }
        if (changes.script_errors) {
            app.status.script_errors = changes.script_errors.newValue || {};
        }
        render_tree();
        refresh_problems();
    }
    if (area !== 'local') {
        return;
    }
    if (changes.moss_enabled) {
        app.enabled = changes.moss_enabled.newValue !== false;
        render_moss_enabled();
    }
    if (changes.updates) {
        app.updates = changes.updates.newValue || {};
        if (app.tab === 'options' && current() !== null) {
            $('options-source').replaceChildren(source_box(current()));
        }
    }
    if (!changes.scripts && !changes.modules) {
        return;
    }
    if (changes.scripts) {
        const before = current() !== null ? current().code : null;
        app.scripts = changes.scripts.newValue || {};
        const after = current() !== null ? current().code : null;
        // Changed elsewhere (e.g. an auto-update) while open here.
        const outside = before !== null && after !== null && before !== after && after !== $('code').value && after !== app.own_write;
        if (outside && !app.dirty) {
            await select('script', app.sel.id, true);
            toast('This script was updated from its source');
        } else if (outside) {
            toast('This script was updated from its source. Saving now would overwrite that update.', 'error');
        }
    }
    if (changes.modules) {
        app.modules = changes.modules.newValue || {};
    }
    if (current() !== null) {
        $('enabled').checked = !!current().enabled;
    }
    render_tree();
}

// ---------- wiring & boot ----------

/*
 * wire() — connect every button and field to its handler
 */
function wire() {
    $('tabs').addEventListener('click', function (event) {
        const button = event.target.closest('button');
        if (button === null || !button.dataset.tab) {
            return;
        }
        app.tab = button.dataset.tab;
        render_tabs();
    });
    document.querySelector('.views').addEventListener('click', function (event) {
        const button = event.target.closest('button');
        if (button === null || !button.dataset.view) {
            return;
        }
        const view = button.dataset.view;
        for (const b of document.querySelectorAll('.views button')) {
            b.classList.toggle('active', b.dataset.view === view);
        }
        for (const v of document.querySelectorAll('.view')) {
            v.hidden = v.id !== `view-${view}`;
        }
        if (view === 'settings') {
            render_settings();
        }
    });

    $('code').addEventListener('scroll', function () {
        $('gutter').scrollTop = $('code').scrollTop;
    });
    $('code').addEventListener('input', function () {
        app.dirty = true;
        $('dirty').hidden = false;
        update_gutter();
        refresh_problems();
    });
    $('code').addEventListener('keydown', on_editor_key);
    document.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (app.sel !== null && app.sel.kind !== 'builtin') {
                save();
            }
        }
    });
    window.addEventListener('beforeunload', function (event) {
        if (app.dirty) {
            event.preventDefault();
        }
    });

    $('save').addEventListener('click', save);
    $('enabled').addEventListener('change', toggle_enabled);
    $('delete').addEventListener('click', delete_selected);
    $('override').addEventListener('click', override_builtin);
    $('update').addEventListener('click', function () {
        update_from_source(current());
    });
    $('new-script').addEventListener('click', function () {
        if (!app.dirty || confirm('Discard unsaved changes?')) {
            create_script(template(''));
        }
    });
    $('new-module').addEventListener('click', new_module);
    $('fix').addEventListener('click', function () {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    });

    $('import').addEventListener('click', open_import);
    $('im-url').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            lookup();
        }
    });
    $('im-lookup').addEventListener('click', function (event) {
        event.preventDefault();
        lookup();
    });
    $('im-file').addEventListener('click', function (event) {
        event.preventDefault();
        $('import-dialog').close();
        $('import-file').click();
    });
    $('im-go').addEventListener('click', function (event) {
        event.preventDefault();
        import_picked();
    });
    $('import-file').addEventListener('change', async function () {
        const file = $('import-file').files[0];
        if (file) {
            await import_code(await file.text());
        }
        $('import-file').value = '';
    });
    $('check-all').addEventListener('click', check_all);

    $('values-save').addEventListener('click', save_values);
    $('values-clear').addEventListener('click', clear_values);
    $('settings-reset').addEventListener('click', reset_settings);
    $('backup-export').addEventListener('click', export_backup);
    $('backup-import').addEventListener('click', function () {
        $('backup-file').click();
    });
    $('backup-file').addEventListener('change', function () {
        const file = $('backup-file').files[0];
        $('backup-file').value = '';
        if (file) {
            import_backup(file);
        }
    });

    $('export').addEventListener('click', open_export);
    const refresh_soon = debounce(function () {
        exporter.manifest_edited = false;
        refresh_export();
    }, 300);
    for (const id of ['ex-name', 'ex-version', 'ex-description']) {
        $(id).addEventListener('input', refresh_soon);
    }
    for (const id of ['ex-source', 'ex-readme']) {
        $(id).addEventListener('change', refresh_export);
    }
    $('ex-manifest').addEventListener('input', debounce(function () {
        exporter.manifest_edited = true;
        refresh_export();
    }, 400));
    $('ex-download').addEventListener('click', download_export);

    chrome.storage.onChanged.addListener(on_storage_change);
}

/*
 * main() — load everything and open what the URL asks for
 */
async function main() {
    wire();
    await load_all();
    await load_status();
    render_moss_enabled();
    render_tree();
    setInterval(watch_local_files, 1500);
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const module_name = params.get('module');
    if (params.has('new')) {
        await create_script(template(params.get('new')));
    } else if (id && app.scripts[id]) {
        await select('script', id);
    } else if (module_name) {
        if (app.modules[module_name]) {
            await select('module', module_name);
        } else if (BUILTIN_MODULES[module_name]) {
            await select('builtin', module_name);
        }
    }
}

main();
