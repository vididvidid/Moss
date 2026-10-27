'use strict';
/*
 * moss/ui/panel — a floating, draggable, collapsible panel.
 *     const p = panel({ title: 'Tools', body: 'Hello', position: 'top-right', width: 280,
 *                       actions: [{ label: 'Run', on_click: run, variant: 'primary' }], id: 'tools' });
 *     p.set_body(node); p.set_title(text); p.show(); p.hide(); p.toggle(); p.close();
 * With an `id`, position and collapsed state are remembered — but only if the
 * script already uses GM values (optional access: api['GM_getValue']).
 */
const core = require('moss/ui/core');
const button = require('moss/ui/button');

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

const POSITIONS = {
    'top-right': { top: '16px', right: '16px' },
    'top-left': { top: '16px', left: '16px' },
    'bottom-right': { bottom: '16px', right: '16px' },
    'bottom-left': { bottom: '16px', left: '16px' },
};

/*
 * panel(opts) -> { el, body, set_body, set_title, show, hide, toggle, toggle_collapsed, close }
 */
function panel(opts) {
    const o = opts || {};
    const get_value = api['GM_getValue'];
    const set_value = api['GM_setValue'];
    const key = (o.id && get_value) ? 'moss.ui.panel.' + o.id : null;
    const saved = key !== null ? get_value(key, {}) : {};

    const title = core.h('span', { class: 'title' }, o.title || '');
    const body = core.h('div', { class: 'panel-body' }, o.body);
    const head = core.h('div', { class: 'panel-head' }, title);
    const el = core.h('div', { class: 'panel', style: { width: o.width ? o.width + 'px' : '' } }, head, body);

    /*
     * save() — remember position and collapsed state
     */
    function save() {
        if (key === null) {
            return;
        }
        const r = el.getBoundingClientRect();
        set_value(key, { left: Math.round(r.left), top: Math.round(r.top), collapsed: el.classList.contains('collapsed') });
    }

    /*
     * toggle_collapsed() — fold the panel down to its title bar, or open it again
     */
    function toggle_collapsed() {
        el.classList.toggle('collapsed');
        save();
    }

    /*
     * close() — remove the panel
     */
    function close() {
        el.remove();
        if (o.on_close) {
            o.on_close();
        }
    }

    /*
     * start_drag(event) — follow the pointer while the title bar is held
     */
    function start_drag(event) {
        if (event.target.closest('button')) {
            return;
        }
        const r = el.getBoundingClientRect();
        const dx = event.clientX - r.left;
        const dy = event.clientY - r.top;
        head.setPointerCapture(event.pointerId);

        /*
         * move(ev) — place the panel under the pointer, kept on screen
         */
        function move(ev) {
            const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 40);
            const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 30);
            Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
        }

        /*
         * up() — stop dragging and remember where the panel ended up
         */
        function up() {
            head.removeEventListener('pointermove', move);
            head.removeEventListener('pointerup', up);
            save();
        }

        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
    }

    if (o.actions && o.actions.length > 0) {
        const buttons = [];
        for (const action of o.actions) {
            buttons.push(button(action.label, action.on_click, { variant: action.variant, small: true }));
        }
        el.appendChild(core.h('div', { class: 'panel-actions' }, buttons));
    }
    if (o.collapsible !== false) {
        head.appendChild(button('–', toggle_collapsed, { variant: 'ghost', small: true, title: 'Collapse' }));
    }
    if (o.closable !== false) {
        head.appendChild(button('×', close, { variant: 'ghost', small: true, title: 'Close' }));
    }
    if (saved.left !== undefined) {
        Object.assign(el.style, { left: saved.left + 'px', top: saved.top + 'px' });
    } else {
        Object.assign(el.style, POSITIONS[o.position] || POSITIONS['top-right']);
    }
    if (saved.collapsed) {
        el.classList.add('collapsed');
    }
    if (o.draggable !== false) {
        head.addEventListener('pointerdown', start_drag);
    }

    core.layer('panels').appendChild(el);

    return {
        el: el,
        body: body,
        set_body: function (content) {
            body.textContent = '';
            body.appendChild(core.render(content));
        },
        set_title: function (text) {
            title.textContent = text;
        },
        show: function () {
            el.style.display = '';
        },
        hide: function () {
            el.style.display = 'none';
        },
        toggle: function () {
            el.style.display = el.style.display === 'none' ? '' : 'none';
        },
        toggle_collapsed: toggle_collapsed,
        close: close,
    };
}

module.exports = panel;
