'use strict';
/*
 * moss/ui/core — the layer every Moss UI component renders into.
 * One closed shadow root per script: page CSS can't break the UI, and the UI
 * can't break the page. Components add their own CSS with style(), so a bundle
 * only carries the CSS of the components it actually uses.
 *
 *     const core = require('moss/ui/core');
 *     core.theme({ accent: '#d6336c', radius: '4px' });
 *     core.h('button', { class: 'btn', on_click: go }, 'Go');
 */
let host = null;
let root = null;
const styles = {};
const layers = {};

const BASE = [
    ':host { all: initial; --accent: #4a7c34; --accent-fg: #fff; --bg: #ffffff; --fg: #1c2418; --muted: #66705f;',
    '  --border: #d9e0d2; --hover: #eef3e8; --danger: #c0392b; --radius: 10px;',
    '  --shadow: 0 10px 30px rgba(20, 30, 15, .18), 0 2px 6px rgba(20, 30, 15, .12);',
    '  --font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }',
    '@media (prefers-color-scheme: dark) { :host { --bg: #1d2219; --fg: #e3ead9; --muted: #9aa58f;',
    '  --border: #343d2e; --hover: #2a3125; --accent: #7fb35c; --accent-fg: #11160e; } }',
    '* { box-sizing: border-box; }',
    '.moss-layer { font: var(--font); color: var(--fg); }',
].join('\n');

/*
 * attach_host() — (re)insert the host element if the page removed it
 */
function attach_host() {
    if (!host.isConnected) {
        (document.body || document.documentElement).appendChild(host);
    }
}

/*
 * mount() -> the shadow root, created on first use
 */
function mount() {
    if (root !== null) {
        return root;
    }
    host = document.createElement('moss-ui');
    host.style.cssText = 'all:initial !important; position:fixed !important; top:0 !important; left:0 !important;' +
        'width:0 !important; height:0 !important; z-index:2147483647 !important;';
    root = host.attachShadow({ mode: 'closed' });
    style('base', BASE);
    attach_host();
    // Some single-page apps replace <body>; put the UI back when that happens.
    new MutationObserver(attach_host).observe(document.documentElement, { childList: true, subtree: true });
    return root;
}

/*
 * style(id, css) — add a component's CSS once
 */
function style(id, css) {
    if (styles[id]) {
        return;
    }
    styles[id] = true;
    const el = document.createElement('style');
    el.textContent = css;
    mount().appendChild(el);
}

/*
 * layer(name, css) -> a named container (e.g. "toasts") so components stack predictably
 */
function layer(name, css) {
    if (layers[name] !== undefined) {
        return layers[name];
    }
    const el = document.createElement('div');
    el.className = 'moss-layer moss-layer-' + name;
    if (css) {
        el.style.cssText = css;
    }
    mount().appendChild(el);
    layers[name] = el;
    return el;
}

/*
 * theme(vars) — override design tokens: accent, accent_fg, bg, fg, muted, border,
 * hover, danger, radius, font, shadow
 */
function theme(vars) {
    mount();
    for (const key of Object.keys(vars)) {
        host.style.setProperty('--' + key.replace(/_/g, '-'), vars[key]);
    }
}

/*
 * render(content) -> a DOM node from a string, node, array or function
 */
function render(content) {
    if (content === null || content === undefined || content === false) {
        return document.createTextNode('');
    }
    if (typeof content === 'function') {
        return render(content());
    }
    if (Array.isArray(content)) {
        const frag = document.createDocumentFragment();
        for (const item of content) {
            frag.appendChild(render(item));
        }
        return frag;
    }
    if (content instanceof Node) {
        return content;
    }
    return document.createTextNode(String(content));
}

/*
 * h(tag, props, ...children) -> a new element
 *   props: class, style (object or string), on_<event> handlers, attributes, properties
 */
function h(tag, props) {
    const el = document.createElement(tag);
    const p = props || {};
    for (const key of Object.keys(p)) {
        const value = p[key];
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key === 'class') {
            el.className = value;
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
        } else if (key.startsWith('on_')) {
            el.addEventListener(key.slice(3), value);
        } else if (key in el && typeof value !== 'string') {
            el[key] = value;
        } else {
            el.setAttribute(key, value === true ? '' : value);
        }
    }
    for (let i = 2; i < arguments.length; i++) {
        el.appendChild(render(arguments[i]));
    }
    return el;
}

exports.root = mount;
exports.style = style;
exports.layer = layer;
exports.theme = theme;
exports.render = render;
exports.h = h;
