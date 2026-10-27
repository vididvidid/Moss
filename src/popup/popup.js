'use strict';
/*
 * Toolbar popup: scripts on this tab, background scripts, menu commands and errors.
 */
import { parse_meta, url_matches } from '../lib/meta.js';
import { request_permissions_for } from '../lib/permissions.js';
import { load_moss_enabled, load_scripts, patch_script, save_moss_enabled } from '../lib/store.js';

/*
 * $(id) -> the element with that id
 */
function $(id) {
    return document.getElementById(id);
}

/*
 * el(tag, class_name, text) -> a new element
 */
function el(tag, class_name, text) {
    const node = document.createElement(tag);
    if (class_name) {
        node.className = class_name;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/*
 * open_dashboard(query) — open the dashboard in a tab and close the popup
 */
async function open_dashboard(query) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html${query || ''}`) });
    window.close();
}

/*
 * mode_of(s) -> the sandbox a script runs in, options first
 */
function mode_of(s) {
    return (s.options && s.options.sandbox) || s.meta.sandbox;
}

/*
 * script_row(s, status) -> the row for one script (toggle, name, mode, errors)
 */
function script_row(s, status) {
    const sync_errors = status.sync_status ? status.sync_status.errors || {} : {};
    const runtime_errors = status.script_errors || {};

    const toggle = el('input', 'switch');
    toggle.type = 'checkbox';
    toggle.checked = !!s.enabled;
    toggle.title = s.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('change', async function () {
        if (toggle.checked) {
            await request_permissions_for(s.code); // first await: keeps the user gesture
        }
        await patch_script(s.id, { enabled: toggle.checked });
    });

    const name = el('span', 'name', s.meta.name || '(unnamed)');
    name.addEventListener('click', function () {
        open_dashboard(`?id=${s.id}`);
    });
    const li = el('li');
    li.append(toggle, name, el('span', `chip ${mode_of(s)}`, mode_of(s)));
    if (sync_errors[s.id]) {
        const warn = el('span', 'error', '⚠');
        warn.title = sync_errors[s.id];
        li.append(warn);
    }

    const errors = runtime_errors[s.id];
    if (!errors || errors.length === 0) {
        return li;
    }
    // Show the latest runtime error under the script; click to dismiss it.
    const latest = errors[0];
    const line = el('div', 'error-line', `⚠ ${latest.message.split('\n')[0]}`);
    line.title = `${latest.message}\n\nClick to dismiss`;
    line.addEventListener('click', async function () {
        await chrome.runtime.sendMessage({ type: 'errors.clear', id: s.id });
        line.remove();
    });
    const wrap = el('div');
    wrap.append(li, line);
    return wrap;
}

/*
 * command_row(item, names) -> the row for one menu command
 */
function command_row(item, names) {
    const li = el('li', 'command');
    li.append(el('span', 'name', item.caption), el('span', 'from', names[item.script_id] || ''));
    li.addEventListener('click', async function () {
        await chrome.runtime.sendMessage({ type: 'menu.run', conn: item.conn, id: item.id });
        window.close();
    });
    return li;
}

/*
 * fill(list, rows, empty) — show rows in list, or the empty message
 */
function fill(list, rows, empty) {
    list.replaceChildren(...rows);
    if (rows.length === 0 && empty) {
        list.replaceChildren(el('div', 'empty', empty));
    }
}

/*
 * render_moss_enabled(on) — the global switch in the header and the "switched off" banner
 */
function render_moss_enabled(on) {
    $('moss-enabled').checked = on;
    $('moss-enabled-label').textContent = on ? 'On' : 'Off';
    $('off-banner').hidden = on;
}

/*
 * main() — build the popup for the active tab
 */
async function main() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.length > 0 ? tabs[0] : null;
    const url = tab !== null && tab.url ? tab.url : '';
    const stored = await load_scripts();
    const reply = await chrome.runtime.sendMessage({ type: 'status' });
    const status = reply && reply.ok ? reply.value : {};

    $('banner').hidden = status.user_scripts !== false;
    render_moss_enabled(await load_moss_enabled());
    $('moss-enabled').addEventListener('change', async function () {
        const on = $('moss-enabled').checked;
        render_moss_enabled(on);
        await save_moss_enabled(on);
    });
    $('fix').addEventListener('click', function () {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    });
    $('open-dashboard').addEventListener('click', function () {
        open_dashboard('');
    });
    $('new-here').addEventListener('click', function () {
        open_dashboard(/^https?:/.test(url) ? `?new=${encodeURIComponent(new URL(url).origin)}` : '?new=');
    });

    const names = {};
    const on_page = [];
    const background = [];
    for (const id of Object.keys(stored)) {
        const s = Object.assign({}, stored[id], { meta: parse_meta(stored[id].code).meta });
        names[s.id] = s.meta.name;
        if (mode_of(s) === 'extension') {
            background.push(script_row(s, status));
        } else if (url_matches(s.meta, url, s.options)) {
            on_page.push(script_row(s, status));
        }
    }
    fill($('page-scripts'), on_page, 'No scripts match this page.');
    $('bg-section').hidden = background.length === 0;
    fill($('bg-scripts'), background);

    const menu_reply = await chrome.runtime.sendMessage({ type: 'menu.list', tab_id: tab !== null ? tab.id : -1 });
    const menus = menu_reply && menu_reply.ok ? menu_reply.value : [];
    $('commands-section').hidden = menus.length === 0;
    const rows = [];
    for (const item of menus) {
        rows.push(command_row(item, names));
    }
    fill($('commands'), rows);
}

main();
