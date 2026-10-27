// moss/ui/modal — dialogs that return promises.
//   await modal({ title, body, actions: [{ label: 'OK', value: true, variant: 'primary' }] })
//   await confirm('Delete it?')        → true / false
//   await prompt('Name?', 'default')   → string / null
//   await alert('Done')
var core = require('moss/ui/core');
var button = require('moss/ui/button');

core.style('modal', [
  '.backdrop { position: fixed; inset: 0; background: rgba(10, 14, 8, .45); display: grid; place-items: center; }',
  '.modal { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius);',
  '  box-shadow: var(--shadow); width: min(440px, calc(100vw - 32px)); max-height: 85vh; display: flex; flex-direction: column; }',
  '.modal h2 { font-size: 15px; margin: 0; padding: 14px 16px 0; }',
  '.modal-body { padding: 12px 16px; overflow: auto; }',
  '.modal-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 16px 14px; }',
  '.modal input.prompt { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);',
  '  border-radius: 6px; padding: 6px 8px; margin-top: 8px; }',
].join('\n'));

function modal(opts) {
  return new Promise(function (resolve) {
    var actions = opts.actions || [{ label: 'OK', value: true, variant: 'primary' }];
    var backdrop;
    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(opts.dismissValue !== undefined ? opts.dismissValue : null); }
    }
    var buttons = actions.map(function (a) {
      return button(a.label, function () { done(typeof a.value === 'function' ? a.value() : a.value); }, { variant: a.variant });
    });
    backdrop = core.h('div', { class: 'backdrop', onClick: function (e) { if (e.target === backdrop) onKey({ key: 'Escape', stopPropagation: function () {} }); } },
      core.h('div', { class: 'modal', role: 'dialog' },
        opts.title ? core.h('h2', null, opts.title) : null,
        core.h('div', { class: 'modal-body' }, opts.body),
        core.h('div', { class: 'modal-actions' }, buttons)));
    document.addEventListener('keydown', onKey, true);
    core.layer('modals').appendChild(backdrop);
    var focus = backdrop.querySelector('input, textarea, select') || buttons[buttons.length - 1];
    if (focus) focus.focus();
  });
}

exports.modal = modal;
exports.alert = function (message, opts) {
  return modal({ title: opts && opts.title, body: message }).then(function () {});
};
exports.confirm = function (message, opts) {
  opts = opts || {};
  return modal({ title: opts.title, body: message, dismissValue: false, actions: [
    { label: opts.cancelLabel || 'Cancel', value: false },
    { label: opts.okLabel || 'OK', value: true, variant: opts.danger ? 'danger' : 'primary' },
  ] });
};
exports.prompt = function (message, value, opts) {
  opts = opts || {};
  var input = core.h('input', { class: 'prompt', value: value == null ? '' : String(value) });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') input.closest('.modal').querySelector('.btn.primary').click(); });
  return modal({ title: opts.title, body: [message, input], actions: [
    { label: 'Cancel', value: null },
    { label: opts.okLabel || 'OK', value: function () { return input.value; }, variant: 'primary' },
  ] });
};
