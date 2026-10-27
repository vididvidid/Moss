// moss/ui/toast — toast(message, { type: 'info' | 'success' | 'error', timeout: 3000, position: 'bottom-right' })
// Returns { close }. Shortcuts: toast.success(msg), toast.error(msg).
var core = require('moss/ui/core');

core.style('toast', [
  '.moss-layer-toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; }',
  '.moss-layer-toasts.top { bottom: auto; top: 16px; }',
  '.toast { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-left: 4px solid var(--accent);',
  '  border-radius: var(--radius); box-shadow: var(--shadow); padding: 9px 14px; max-width: 360px;',
  '  opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s; }',
  '.toast.show { opacity: 1; transform: none; }',
  '.toast.success { border-left-color: #3a9d5d; } .toast.error { border-left-color: var(--danger); }',
].join('\n'));

function toast(message, opts) {
  opts = opts || {};
  var layer = core.layer('toasts');
  if (opts.position === 'top') layer.classList.add('top');
  var el = core.h('div', { class: 'toast ' + (opts.type || 'info'), role: 'status' }, message);
  layer.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('show'); });
  function close() {
    el.classList.remove('show');
    setTimeout(function () { el.remove(); }, 200);
  }
  if (opts.timeout !== 0) setTimeout(close, opts.timeout || 3000);
  return { close: close };
}
toast.success = function (m, o) { return toast(m, Object.assign({}, o, { type: 'success' })); };
toast.error = function (m, o) { return toast(m, Object.assign({}, o, { type: 'error' })); };

module.exports = toast;
