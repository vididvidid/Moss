// moss/ui/form — form fields from a schema.
//   const f = form([{ key: 'name', label: 'Name', type: 'text' }, …], { name: 'x' })
//   f.el (a node), f.values() → { name: … }
// Field types: text, number, checkbox, select (options: ['a', 'b'] or [{ value, label }]),
// textarea, color, list (one item per line → array).
var core = require('moss/ui/core');

core.style('form', [
  '.form { display: flex; flex-direction: column; gap: 12px; }',
  '.field { display: flex; flex-direction: column; gap: 4px; }',
  '.field.check { flex-direction: row; align-items: center; gap: 8px; }',
  '.field label { font-weight: 600; font-size: 12px; }',
  '.field .hint { color: var(--muted); font-size: 12px; }',
  '.field input:not([type=checkbox]), .field select, .field textarea { font: inherit; color: var(--fg); background: var(--bg);',
  '  border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; }',
  '.field textarea { min-height: 70px; resize: vertical; }',
  '.field input:focus, .field select:focus, .field textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }',
  '.field input[type=checkbox] { accent-color: var(--accent); width: 16px; height: 16px; }',
].join('\n'));

function field(f, value) {
  var id = 'f-' + f.key + '-' + Math.random().toString(36).slice(2, 7);
  var input;
  if (f.type === 'checkbox') {
    input = core.h('input', { id: id, type: 'checkbox', checked: !!value });
    return { el: core.h('div', { class: 'field check' }, input, core.h('label', { for: id }, f.label || f.key)),
      get: function () { return input.checked; } };
  }
  if (f.type === 'select') {
    input = core.h('select', { id: id }, (f.options || []).map(function (o) {
      var v = typeof o === 'object' ? o.value : o;
      return core.h('option', { value: v, selected: String(v) === String(value) }, typeof o === 'object' ? o.label : o);
    }));
  } else if (f.type === 'textarea' || f.type === 'list') {
    input = core.h('textarea', { id: id }, f.type === 'list' ? (value || []).join('\n') : value || '');
  } else {
    input = core.h('input', { id: id, type: f.type || 'text', value: value == null ? '' : value, placeholder: f.placeholder });
  }
  return {
    el: core.h('div', { class: 'field' }, core.h('label', { for: id }, f.label || f.key), input, f.hint ? core.h('div', { class: 'hint' }, f.hint) : null),
    get: function () {
      if (f.type === 'number') return input.value === '' ? null : Number(input.value);
      if (f.type === 'list') return input.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      return input.value;
    },
  };
}

exports.field = field;
exports.form = function (fields, values) {
  values = values || {};
  var made = fields.map(function (f) { return { key: f.key, f: field(f, values[f.key]) }; });
  return {
    el: core.h('div', { class: 'form' }, made.map(function (m) { return m.f.el; })),
    values: function () {
      var out = {};
      made.forEach(function (m) { out[m.key] = m.f.get(); });
      return out;
    },
  };
};
