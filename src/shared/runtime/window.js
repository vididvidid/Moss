/*
 * Feature: window — "@grant window.close" lets the script close its own tab and
 * "@grant window.focus" bring it to the front, which pages normally may not do.
 */
(function () {
    'use strict';
    const g = globalThis;
    const grants = rt.ctx.info.grant || [];

    if (grants.indexOf('window.close') >= 0) {
        g.close = function () {
            rt.call('window.close').catch(rt.report);
        };
    }
    if (grants.indexOf('window.focus') >= 0) {
        g.focus = function () {
            rt.call('window.focus').catch(rt.report);
        };
    }
})();
