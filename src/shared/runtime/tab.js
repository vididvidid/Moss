/*
 * Feature: tab — GM_getTab / GM_saveTab / GM_getTabs. Each tab keeps one object per
 * script for as long as the tab is open (reloads and navigation included).
 *     GM_getTab(fn)      fn(obj) with this tab's object ({} at first)
 *     GM_saveTab(obj)    replace it
 *     GM_getTabs(fn)     fn({ [tab id]: obj }) for every open tab of this script
 */
(function () {
    'use strict';

    /*
     * clone(value) -> a JSON copy (tab objects are stored as JSON, like Tampermonkey's)
     */
    function clone(value) {
        return JSON.parse(JSON.stringify(value === undefined ? {} : value));
    }

    /*
     * with_callback(promise, fn) — call fn with the result, reporting failures
     */
    function with_callback(promise, fn) {
        promise.then(function (value) {
            if (typeof fn === 'function') {
                fn(value);
            }
        }).catch(rt.report);
    }

    rt.api.GM_getTab = function (fn) {
        with_callback(rt.call('tab.get'), fn);
    };
    rt.api.GM_saveTab = function (obj) {
        rt.call('tab.save', [clone(obj)]).catch(rt.report);
    };
    rt.api.GM_getTabs = function (fn) {
        with_callback(rt.call('tab.list'), fn);
    };
    rt.gm.getTab = function () {
        return rt.call('tab.get');
    };
    rt.gm.saveTab = function (obj) {
        return rt.call('tab.save', [clone(obj)]);
    };
    rt.gm.getTabs = function () {
        return rt.call('tab.list');
    };
})();
