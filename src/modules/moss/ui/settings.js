// moss/ui/settings — a settings dialog from a schema, saved with GM values.
//   const prefs = settings({
//     title: 'My script', key: 'settings',
//     fields: [{ key: 'wpm', label: 'Words per minute', type: 'number', default: 230 }],
//     menu: true,   // add "⚙ My script settings" to the popup (if the script has menu commands)
//     fab: false,   // or a floating ⚙ button — handy in page mode
//   })
//   prefs.get('wpm'), prefs.values, prefs.set('wpm', 300), prefs.open(), prefs.onChange(fn)
var form = require('moss/ui/form');
var modal = require('moss/ui/modal');

module.exports = function settings(opts) {
  var key = opts.key || 'settings';
  var fields = opts.fields || [];
  var defaults = {};
  fields.forEach(function (f) {
    defaults[f.key] = f.default !== undefined ? f.default : f.type === 'checkbox' ? false : f.type === 'list' ? [] : '';
  });
  var listeners = [];

  function values() { return Object.assign({}, defaults, api.GM_getValue(key, {})); }
  function store(next) {
    api.GM_setValue(key, next);
    listeners.forEach(function (fn) { fn(next); });
  }
  function open() {
    var f = form.form(fields, values());
    return modal.modal({ title: opts.title || 'Settings', body: f.el, actions: [
      { label: 'Reset', value: 'reset', variant: 'ghost' },
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', variant: 'primary' },
    ] }).then(function (choice) {
      if (choice === 'save') store(Object.assign(values(), f.values()));
      if (choice === 'reset') store({});
      return values();
    });
  }

  // Optional access: only uses menu commands if the script already includes them.
  var register = api['GM_registerMenuCommand'];
  if (opts.menu !== false && register) register(typeof opts.menu === 'string' ? opts.menu : '⚙ ' + (opts.title || 'Settings'), open);
  if (opts.fab) require('moss/ui/fab')({ icon: '⚙', title: opts.title || 'Settings', onClick: open, position: opts.fab === true ? 'bottom-left' : opts.fab });

  return {
    get: function (k) { return values()[k]; },
    get values() { return values(); },
    set: function (k, v) { var next = api.GM_getValue(key, {}); next[k] = v; store(next); },
    open: open,
    onChange: function (fn) { listeners.push(fn); },
  };
};
