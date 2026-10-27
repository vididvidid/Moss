'use strict';
/*
 * moss/ui/button — button(label, on_click, { variant: 'primary' | 'ghost' | 'danger', small, title })
 */
const core = require('moss/ui/core');

core.style('button', [
    '.btn { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);',
    '  border-radius: calc(var(--radius) - 3px); padding: 6px 12px; cursor: pointer; line-height: 1.2; }',
    '.btn:hover { background: var(--hover); }',
    '.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }',
    '.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }',
    '.btn.primary:hover { filter: brightness(1.08); }',
    '.btn.danger { color: var(--danger); }',
    '.btn.ghost { border-color: transparent; background: transparent; }',
    '.btn.ghost:hover { background: var(--hover); }',
    '.btn.sm { padding: 3px 8px; font-size: 12px; }',
].join('\n'));

/*
 * button(label, on_click, opts) -> a styled <button>
 */
function button(label, on_click, opts) {
    const o = opts || {};
    let cls = 'btn';
    if (o.variant) {
        cls += ' ' + o.variant;
    }
    if (o.small) {
        cls += ' sm';
    }
    return core.h('button', { class: cls, type: 'button', title: o.title, on_click: on_click }, label);
}

module.exports = button;
