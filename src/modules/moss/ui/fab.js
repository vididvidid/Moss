// moss/ui/fab — a floating action button, optionally with a small menu.
//   fab({ icon: '⚙', title: 'Tools', onClick: fn, position: 'bottom-right' })
//   fab({ icon: '✎', actions: [{ label: 'Do it', onClick: fn }, …] })
// Returns { el, remove }.
var core = require('moss/ui/core');

core.style('fab', [
  '.fab-wrap { position: fixed; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }',
  '.fab-wrap.left { align-items: flex-start; }',
  '.fab { width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer; font-size: 18px;',
  '  background: var(--accent); color: var(--accent-fg); box-shadow: var(--shadow); opacity: .85; transition: opacity .15s, transform .15s; }',
  '.fab:hover { opacity: 1; transform: scale(1.05); }',
  '.fab-menu { display: none; flex-direction: column; background: var(--bg); border: 1px solid var(--border);',
  '  border-radius: var(--radius); box-shadow: var(--shadow); padding: 4px; min-width: 170px; }',
  '.fab-wrap.open .fab-menu { display: flex; }',
  '.fab-menu button { font: inherit; color: var(--fg); background: none; border: 0; text-align: left; padding: 7px 10px; border-radius: 6px; cursor: pointer; }',
  '.fab-menu button:hover { background: var(--hover); }',
].join('\n'));

var SPOTS = {
  'bottom-right': { bottom: '20px', right: '20px' }, 'bottom-left': { bottom: '20px', left: '20px' },
  'top-right': { top: '20px', right: '20px' }, 'top-left': { top: '20px', left: '20px' },
};

module.exports = function fab(opts) {
  opts = opts || {};
  var pos = opts.position || 'bottom-right';
  var wrap = core.h('div', { class: 'fab-wrap' + (/left/.test(pos) ? ' left' : '') });
  Object.assign(wrap.style, SPOTS[pos] || SPOTS['bottom-right']);

  var menu = null;
  if (opts.actions && opts.actions.length) {
    menu = core.h('div', { class: 'fab-menu', role: 'menu' }, opts.actions.map(function (a) {
      return core.h('button', { type: 'button', onClick: function () { wrap.classList.remove('open'); a.onClick(); } }, a.label);
    }));
    wrap.appendChild(menu);
  }
  var btn = core.h('button', { class: 'fab', type: 'button', title: opts.title || '', 'aria-label': opts.title || 'Menu',
    onClick: function () { if (menu) wrap.classList.toggle('open'); if (opts.onClick) opts.onClick(); } }, opts.icon || '★');
  wrap.appendChild(btn);
  if (/top/.test(pos)) wrap.insertBefore(btn, menu);

  core.layer('fabs').appendChild(wrap);
  return { el: wrap, remove: function () { wrap.remove(); } };
};
