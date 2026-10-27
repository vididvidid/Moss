'use strict';
/*
 * moss/ui/form — form fields from a schema.
 *     const f = form([{ key: 'name', label: 'Name', type: 'text' }, …], { name: 'x' });
 *     f.el (a node), f.values() → { name: … }
 * Field types: text, number, checkbox, select (options: ['a', 'b'] or [{ value, label }]),
 * textarea, color, list (one item per line → array).
 *
 * struct field_def { key, label, type, options, default, hint, placeholder }
 */
const core = require('moss/ui/core');

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

/*
 * select_input(id, def, value) -> a <select> for def.options
 */
function select_input(id, def, value) {
    const options = [];
    for (const option of def.options || []) {
        const is_object = typeof option === 'object';
        const v = is_object ? option.value : option;
        options.push(core.h('option', { value: v, selected: String(v) === String(value) }, is_object ? option.label : option));
    }
    return core.h('select', { id: id }, options);
}

/*
 * field(def, value) -> { el, get() } for one struct field_def
 */
function field(def, value) {
    const id = 'f-' + def.key + '-' + Math.random().toString(36).slice(2, 7);
    const label = core.h('label', { for: id }, def.label || def.key);
    if (def.type === 'checkbox') {
        const box = core.h('input', { id: id, type: 'checkbox', checked: !!value });
        return {
            el: core.h('div', { class: 'field check' }, box, label),
            get: function () {
                return box.checked;
            },
        };
    }
    let input;
    if (def.type === 'select') {
        input = select_input(id, def, value);
    } else if (def.type === 'textarea' || def.type === 'list') {
        const text = def.type === 'list' ? (value || []).join('\n') : (value || '');
        input = core.h('textarea', { id: id }, text);
    } else {
        const shown = value === null || value === undefined ? '' : value;
        input = core.h('input', { id: id, type: def.type || 'text', value: shown, placeholder: def.placeholder });
    }
    return {
        el: core.h('div', { class: 'field' }, label, input, def.hint ? core.h('div', { class: 'hint' }, def.hint) : null),
        get: function () {
            if (def.type === 'number') {
                return input.value === '' ? null : Number(input.value);
            }
            if (def.type === 'list') {
                const items = [];
                for (const line of input.value.split('\n')) {
                    if (line.trim() !== '') {
                        items.push(line.trim());
                    }
                }
                return items;
            }
            return input.value;
        },
    };
}

/*
 * form(defs, values) -> { el, values() }
 */
function form(defs, values) {
    const current = values || {};
    const made = [];
    const nodes = [];
    for (const def of defs) {
        const f = field(def, current[def.key]);
        made.push({ key: def.key, field: f });
        nodes.push(f.el);
    }
    return {
        el: core.h('div', { class: 'form' }, nodes),
        values: function () {
            const out = {};
            for (const m of made) {
                out[m.key] = m.field.get();
            }
            return out;
        },
    };
}

exports.field = field;
exports.form = form;
