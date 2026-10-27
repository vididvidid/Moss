'use strict';
/*
 * moss/ui/modal — dialogs that return promises.
 *     await modal({ title, body, actions: [{ label: 'OK', value: true, variant: 'primary' }] })
 *     await confirm('Delete it?')        → true / false
 *     await prompt('Name?', 'default')   → string / null
 *     await alert('Done')
 */
const core = require('moss/ui/core');
const button = require('moss/ui/button');

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

/*
 * modal(opts) -> Promise of the chosen action's value (dismiss_value on Escape / backdrop)
 *   opts: { title, body, actions: [{ label, value, variant }], dismiss_value }
 */
function modal(opts) {
    return new Promise(function (resolve) {
        const actions = opts.actions || [{ label: 'OK', value: true, variant: 'primary' }];
        const dismiss_value = opts.dismiss_value === undefined ? null : opts.dismiss_value;
        let backdrop = null;

        /*
         * done(value) — close the dialog and resolve with value
         */
        function done(value) {
            document.removeEventListener('keydown', on_key, true);
            backdrop.remove();
            resolve(value);
        }

        /*
         * on_key(event) — Escape dismisses
         */
        function on_key(event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                done(dismiss_value);
            }
        }

        const buttons = [];
        for (const action of actions) {
            buttons.push(button(action.label, function () {
                done(typeof action.value === 'function' ? action.value() : action.value);
            }, { variant: action.variant }));
        }
        const dialog = core.h('div', { class: 'modal', role: 'dialog' },
            opts.title ? core.h('h2', null, opts.title) : null,
            core.h('div', { class: 'modal-body' }, opts.body),
            core.h('div', { class: 'modal-actions' }, buttons));
        backdrop = core.h('div', {
            class: 'backdrop',
            on_click: function (event) {
                if (event.target === backdrop) {
                    done(dismiss_value);
                }
            },
        }, dialog);

        document.addEventListener('keydown', on_key, true);
        core.layer('modals').appendChild(backdrop);
        const focus = backdrop.querySelector('input, textarea, select') || buttons[buttons.length - 1];
        if (focus) {
            focus.focus();
        }
    });
}

/*
 * alert(message, opts) -> Promise, resolved when dismissed
 */
function alert(message, opts) {
    return modal({ title: opts && opts.title, body: message }).then(function () {});
}

/*
 * confirm(message, opts) -> Promise<boolean>
 *   opts: { title, ok_label, cancel_label, danger }
 */
function confirm(message, opts) {
    const o = opts || {};
    return modal({
        title: o.title,
        body: message,
        dismiss_value: false,
        actions: [
            { label: o.cancel_label || 'Cancel', value: false },
            { label: o.ok_label || 'OK', value: true, variant: o.danger ? 'danger' : 'primary' },
        ],
    });
}

/*
 * prompt(message, value, opts) -> Promise<string | null>
 *   opts: { title, ok_label }
 */
function prompt(message, value, opts) {
    const o = opts || {};
    const input = core.h('input', { class: 'prompt', value: value === null || value === undefined ? '' : String(value) });
    input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            input.closest('.modal').querySelector('.btn.primary').click();
        }
    });
    return modal({
        title: o.title,
        body: [message, input],
        actions: [
            { label: 'Cancel', value: null },
            { label: o.ok_label || 'OK', value: function () { return input.value; }, variant: 'primary' },
        ],
    });
}

exports.modal = modal;
exports.alert = alert;
exports.confirm = confirm;
exports.prompt = prompt;
