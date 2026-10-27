// moss/ui/core — the layer every Moss UI component renders into.
// One closed shadow root per script: page CSS can't break the UI, and the UI
// can't break the page. Components add their own CSS with style(), so a bundle
// only carries the CSS of the components it actually uses.
//
//   const { h, theme } = require('moss/ui/core');
//   theme({ accent: '#d6336c', radius: '4px' });

var host = null, root = null, styles = {}, layers = {};

var BASE = [
  ':host { all: initial; --accent: #4a7c34; --accent-fg: #fff; --bg: #ffffff; --fg: #1c2418; --muted: #66705f;',
  '  --border: #d9e0d2; --hover: #eef3e8; --danger: #c0392b; --radius: 10px;',
  '  --shadow: 0 10px 30px rgba(20, 30, 15, .18), 0 2px 6px rgba(20, 30, 15, .12);',
  '  --font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }',
  '@media (prefers-color-scheme: dark) { :host { --bg: #1d2219; --fg: #e3ead9; --muted: #9aa58f;',
  '  --border: #343d2e; --hover: #2a3125; --accent: #7fb35c; --accent-fg: #11160e; } }',
  '* { box-sizing: border-box; }',
  '.moss-layer { font: var(--font); color: var(--fg); }',
].join('\n');

function mount() {
  if (root) return root;
  host = document.createElement('moss-ui');
  host.style.cssText = 'all:initial !important; position:fixed !important; top:0 !important; left:0 !important;' +
    'width:0 !important; height:0 !important; z-index:2147483647 !important;';
  root = host.attachShadow({ mode: 'closed' });
  exports.style('base', BASE);
  var attach = function () {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  };
  attach();
  // Some single-page apps replace <body>; put the UI back when that happens.
  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
  return root;
}

exports.root = mount;

exports.style = function (id, css) {
  if (styles[id]) return;
  styles[id] = true;
  var el = document.createElement('style');
  el.textContent = css;
  mount().appendChild(el);
};

// A named container (e.g. "toasts") so components stack predictably.
exports.layer = function (name, css) {
  if (layers[name]) return layers[name];
  var el = document.createElement('div');
  el.className = 'moss-layer moss-layer-' + name;
  if (css) el.style.cssText = css;
  mount().appendChild(el);
  return (layers[name] = el);
};

// theme({ accent, bg, fg, muted, border, hover, danger, radius, font, shadow })
exports.theme = function (vars) {
  mount();
  Object.keys(vars).forEach(function (k) {
    host.style.setProperty('--' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }), vars[k]);
  });
};

// Turns strings, nodes, arrays and functions into DOM nodes.
exports.render = function render(content) {
  if (content == null || content === false) return document.createTextNode('');
  if (typeof content === 'function') return render(content());
  if (Array.isArray(content)) {
    var frag = document.createDocumentFragment();
    content.forEach(function (c) { frag.appendChild(render(c)); });
    return frag;
  }
  if (content instanceof Node) return content;
  return document.createTextNode(String(content));
};

// h('button', { class: 'btn', onClick: fn, style: { color: 'red' } }, 'Label', child…)
exports.h = function h(tag, props) {
  var el = document.createElement(tag);
  props = props || {};
  Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (v == null || v === false) return;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (/^on[A-Z]/.test(k)) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  });
  for (var i = 2; i < arguments.length; i++) el.appendChild(exports.render(arguments[i]));
  return el;
};
