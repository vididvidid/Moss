'use strict';
/*
 * moss/ui — the whole UI kit in one import:  // @use moss/ui as ui
 * For the smallest bundles, @use only the parts you need, e.g. moss/ui/toast.
 */
const core = require('moss/ui/core');
const modal = require('moss/ui/modal');
const form = require('moss/ui/form');

module.exports = {
    h: core.h,
    theme: core.theme,
    style: core.style,
    root: core.root,
    button: require('moss/ui/button'),
    toast: require('moss/ui/toast'),
    panel: require('moss/ui/panel'),
    fab: require('moss/ui/fab'),
    modal: modal.modal,
    alert: modal.alert,
    confirm: modal.confirm,
    prompt: modal.prompt,
    field: form.field,
    form: form.form,
    settings: require('moss/ui/settings'),
};
