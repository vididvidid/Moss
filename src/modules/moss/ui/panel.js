// moss/ui/panel — a floating, draggable, collapsible panel.
//   const p = panel({ title: 'Tools', body: 'Hello', position: 'top-right', width: 280,
//                     actions: [{ label: 'Run', onClick: fn, variant: 'primary' }], id: 'tools' })
//   p.setBody(node), p.setTitle(text), p.show(), p.hide(), p.toggle(), p.close()
// With an `id`, position and collapsed state are remembered — but only if the
// script already uses GM values (optional access: api['GM_getValue']).
var core = require('moss/ui/core');
var button = require('moss/ui/button');

core.style('panel', [
  '.panel { position: fixed; background: var(--bg); color: var(--fg); border: 1px solid var(--border);',
  '  border-radius: var(--radius); box-shadow: var(--shadow); min-width: 200px; max-height: 80vh; display: flex; flex-direction: column; }',
  '.panel-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--border);',
  '  cursor: move; user-select: none; font-weight: 600; }',
  '.panel-head .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.panel.collapsed .panel-body, .panel.collapsed .panel-actions { display: none; }',
  '.panel.collapsed .panel-head { border-bottom: 0; }',
  '.panel-body { padding: 10px 12px; overflow: auto; }',
  '.panel-actions { display: flex; gap: 6px; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid var(--border); }',
].join('\n'));

var POSITIONS = {
  'top-right': { top: '16px', right: '16px' }, 'top-left': { top: '16px', left: '16px' },
  'bottom-right': { bottom: '16px', right: '16px' }, 'bottom-left': { bottom: '16px', left: '16px' },
};

module.exports = function panel(opts) {
  opts = opts || {};
  var getValue = api['GM_getValue'], setValue = api['GM_setValue'];
  var key = opts.id && getValue ? 'moss.ui.panel.' + opts.id : null;
  var saved = key ? getValue(key, {}) : {};

  var title = core.h('span', { class: 'title' }, opts.title || '');
  var body = core.h('div', { class: 'panel-body' }, opts.body);
  var head = core.h('div', { class: 'panel-head' }, title);
  var el = core.h('div', { class: 'panel', style: { width: opts.width ? opts.width + 'px' : '' } }, head, body);

  if (opts.actions && opts.actions.length) {
    el.appendChild(core.h('div', { class: 'panel-actions' }, opts.actions.map(function (a) {
      return button(a.label, a.onClick, { variant: a.variant, small: true });
    })));
  }
  if (opts.collapsible !== false) {
    head.appendChild(button('–', function () { self.toggleCollapsed(); }, { variant: 'ghost', small: true, title: 'Collapse' }));
  }
  if (opts.closable !== false) {
    head.appendChild(button('×', function () { self.close(); }, { variant: 'ghost', small: true, title: 'Close' }));
  }

  if (saved.left != null) Object.assign(el.style, { left: saved.left + 'px', top: saved.top + 'px' });
  else Object.assign(el.style, POSITIONS[opts.position || 'top-right'] || POSITIONS['top-right']);
  if (saved.collapsed) el.classList.add('collapsed');

  function save() {
    if (!key) return;
    var r = el.getBoundingClientRect();
    setValue(key, { left: Math.round(r.left), top: Math.round(r.top), collapsed: el.classList.contains('collapsed') });
  }

  if (opts.draggable !== false) {
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      var r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      function move(ev) {
        var x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 40);
        var y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 30);
        Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
      }
      function up() {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        save();
      }
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
  }

  core.layer('panels').appendChild(el);

  var self = {
    el: el,
    body: body,
    setBody: function (content) { body.textContent = ''; body.appendChild(core.render(content)); },
    setTitle: function (text) { title.textContent = text; },
    show: function () { el.style.display = ''; },
    hide: function () { el.style.display = 'none'; },
    toggle: function () { el.style.display = el.style.display === 'none' ? '' : 'none'; },
    toggleCollapsed: function () { el.classList.toggle('collapsed'); save(); },
    close: function () { el.remove(); if (opts.onClose) opts.onClose(); },
  };
  return self;
};
