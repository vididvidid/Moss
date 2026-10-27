'use strict';
/*
 * moss/ui/toast — toast(message, { type: 'info' | 'success' | 'error', timeout: 3000, position: 'bottom' | 'top' })
 * Returns { close }. Shortcuts: toast.success(message), toast.error(message).
 */
const core = require('moss/ui/core');

core.style('toast', [
    '.moss-layer-toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; }',
    '.moss-layer-toasts.top { bottom: auto; top: 16px; }',
    '.toast { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-left: 4px solid var(--accent);',
    '  border-radius: var(--radius); box-shadow: var(--shadow); padding: 9px 14px; max-width: 360px;',
    '  opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s; }',
    '.toast.show { opacity: 1; transform: none; }',
    '.toast.success { border-left-color: #3a9d5d; } .toast.error { border-left-color: var(--danger); }',
].join('\n'));

/*
 * toast(message, opts) -> { close }
 */
function toast(message, opts) {
    const o = opts || {};
    const layer = core.layer('toasts');
    if (o.position === 'top') {
        layer.classList.add('top');
    }
    const el = core.h('div', { class: 'toast ' + (o.type || 'info'), role: 'status' }, message);
    layer.appendChild(el);
    requestAnimationFrame(function () {
        el.classList.add('show');
    });

    /*
     * close() — fade the toast out and remove it
     */
    function close() {
        el.classList.remove('show');
        setTimeout(function () {
            el.remove();
        }, 200);
    }

    if (o.timeout !== 0) {
        setTimeout(close, o.timeout || 3000);
    }
    return { close: close };
}

toast.success = function (message, opts) {
    return toast(message, Object.assign({}, opts, { type: 'success' }));
};
toast.error = function (message, opts) {
    return toast(message, Object.assign({}, opts, { type: 'error' }));
};

module.exports = toast;
