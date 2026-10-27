'use strict';
/*
 * moss/ui/fab — a floating action button, optionally with a small menu.
 *     fab({ icon: '⚙', title: 'Tools', on_click: go, position: 'bottom-right' })
 *     fab({ icon: '✎', actions: [{ label: 'Do it', on_click: do_it }, …] })
 * Returns { el, remove }.
 */
const core = require('moss/ui/core');

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

const SPOTS = {
    'bottom-right': { bottom: '20px', right: '20px' },
    'bottom-left': { bottom: '20px', left: '20px' },
    'top-right': { top: '20px', right: '20px' },
    'top-left': { top: '20px', left: '20px' },
};

/*
 * fab(opts) -> { el, remove }
 *   opts: { icon, title, on_click, position, actions: [{ label, on_click }] }
 */
function fab(opts) {
    const o = opts || {};
    const position = o.position || 'bottom-right';
    const wrap = core.h('div', { class: 'fab-wrap' + (position.includes('left') ? ' left' : '') });
    Object.assign(wrap.style, SPOTS[position] || SPOTS['bottom-right']);

    let menu = null;
    if (o.actions && o.actions.length > 0) {
        const items = [];
        for (const action of o.actions) {
            items.push(core.h('button', {
                type: 'button',
                on_click: function () {
                    wrap.classList.remove('open');
                    action.on_click();
                },
            }, action.label));
        }
        menu = core.h('div', { class: 'fab-menu', role: 'menu' }, items);
        wrap.appendChild(menu);
    }
    const btn = core.h('button', {
        class: 'fab',
        type: 'button',
        title: o.title || '',
        'aria-label': o.title || 'Menu',
        on_click: function () {
            if (menu !== null) {
                wrap.classList.toggle('open');
            }
            if (o.on_click) {
                o.on_click();
            }
        },
    }, o.icon || '★');
    wrap.appendChild(btn);
    if (position.includes('top')) {
        wrap.insertBefore(btn, menu);
    }

    core.layer('fabs').appendChild(wrap);
    return {
        el: wrap,
        remove: function () {
            wrap.remove();
        },
    };
}

module.exports = fab;
