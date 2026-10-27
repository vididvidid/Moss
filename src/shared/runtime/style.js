/*
 * Feature: style — GM_addStyle / GM_addElement. Purely local, no bridge needed.
 */
(function () {
    'use strict';

    /*
     * head() -> where new <style> elements go
     */
    function head() {
        return document.head || document.documentElement;
    }

    /*
     * add_style(css) -> the new <style> element
     */
    function add_style(css) {
        const el = document.createElement('style');
        el.textContent = String(css);
        head().appendChild(el);
        return el;
    }

    /*
     * add_element(tag, attrs) or add_element(parent, tag, attrs) -> the new element
     */
    function add_element(a, b, c) {
        const has_parent = typeof a !== 'string';
        const parent = has_parent ? a : head();
        const tag = has_parent ? b : a;
        const attrs = (has_parent ? c : b) || {};
        const el = document.createElement(tag);
        for (const key of Object.keys(attrs)) {
            if (key === 'textContent') {
                el.textContent = attrs[key];
            } else {
                el.setAttribute(key, attrs[key]);
            }
        }
        parent.appendChild(el);
        return el;
    }

    rt.api.GM_addStyle = add_style;
    rt.api.GM_addElement = add_element;
    rt.gm.addStyle = function (css) {
        return Promise.resolve(add_style(css));
    };
    rt.gm.addElement = function (a, b, c) {
        return Promise.resolve(add_element(a, b, c));
    };
})();
