// moss/dom — all DOM helpers in one import:  // @use moss/dom as dom
// For smaller bundles, @use the parts: moss/dom/query, moss/dom/wait, moss/dom/url, moss/dom/util.
module.exports = Object.assign({},
  require('moss/dom/query'),
  require('moss/dom/wait'),
  require('moss/dom/url'),
  require('moss/dom/util'));
