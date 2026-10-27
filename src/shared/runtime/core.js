/*
 * Moss runtime core — always injected first. The bundler appends exactly one
 * transport-*.js and only the feature files the script uses; each of those
 * extends the `rt` object created here. No imports: this file runs in user-script
 * worlds, page worlds, sandboxed iframes and service workers.
 *
 * Strict mode is switched on inside this function only, so the user's own code
 * (joined into the same script) keeps whatever mode it asked for.
 *
 * struct rt {
 *     ctx: object;          build-time settings (see build() in src/lib/bundler.js)
 *     api: object;          GM_* functions, handed to the script as parameters
 *     gm: object;           the GM.* promise API
 *     moss: object;         the script's `moss` object
 *     transport: { call(method, args) -> Promise } | null;   null = no extension bridge
 *     waits: Promise[];     settle before the script starts
 *     push: { [kind]: function };   handlers for messages pushed by the extension
 *     resync: function[];   re-run after reconnecting (menus, listeners)
 *     mods: object;         defined modules
 * }
 */
function moss_core(ctx) {
    'use strict';
    const g = globalThis;

    /*
     * url_allowed(filter, url) -> true if url passes the runtime URL filter
     */
    function url_allowed(filter, url) {
        let included = false;
        for (const rule of filter.include) {
            if (rule_test(rule, url)) {
                included = true;
                break;
            }
        }
        if (!included) {
            return false;
        }
        for (const rule of filter.exclude) {
            if (rule_test(rule, url)) {
                return false;
            }
        }
        return true;
    }

    /*
     * rule_test(rule, url) -> true if the [source, flags] rule matches url
     */
    function rule_test(rule, url) {
        try {
            return new RegExp(rule[0], rule[1]).test(url);
        } catch (e) {
            return false;
        }
    }

    if (ctx.filter && g.location && !url_allowed(ctx.filter, g.location.href)) {
        return null;
    }

    const tag = '[' + (ctx.log_prefix || 'Moss') + ': ' + ctx.info.name + ']';
    const rt = {
        ctx: ctx,
        api: {},
        gm: {},
        moss: null,
        transport: null,
        waits: [],
        push: {},
        resync: [],
        mods: {},
    };

    /*
     * log(...args) — console.log with the script's tag
     */
    function log() {
        console.log.apply(console, [tag].concat(Array.prototype.slice.call(arguments)));
    }

    /*
     * report(error) — log a script error and tell the extension about it
     */
    function report(error) {
        if (ctx.log_errors !== false) {
            console.error(tag, error);
        }
        // Errors in background scripts and menu commands would otherwise land in a
        // console nobody is looking at.
        if (rt.transport !== null) {
            const text = String((error && error.stack) || error);
            rt.transport.call('error', [text]).catch(function () {});
        }
    }

    /*
     * call(method, args) -> Promise of the extension's answer
     */
    function call(method, args) {
        if (rt.transport === null) {
            const why = ctx.mode === 'page' ? 'page mode does not have (use @sandbox isolated).' : 'is not bundled.';
            return Promise.reject(new Error('Moss: "' + method + '" needs the extension bridge, which ' + why));
        }
        return rt.transport.call(method, args || []);
    }

    /*
     * on_push(msg) — route a message pushed by the extension to its handler
     */
    function on_push(msg) {
        const handler = rt.push[msg.push];
        if (handler === undefined) {
            return;
        }
        try {
            handler(msg);
        } catch (e) {
            report(e);
        }
    }

    /*
     * reconnected() — re-register menus and listeners after the bridge came back
     */
    function reconnected() {
        for (const fn of rt.resync) {
            try {
                fn();
            } catch (e) {
                report(e);
            }
        }
    }

    /*
     * define(name, factory) — register a bundled module
     */
    function define(name, factory) {
        rt.mods[name] = { factory: factory, module: null };
    }

    /*
     * require_module(name) -> the module's exports, running its factory the first time
     */
    function require_module(name) {
        const m = rt.mods[name];
        if (m === undefined) {
            throw new Error('Moss: module "' + name + '" is not bundled — add "// @use ' + name + '" to the header.');
        }
        if (m.module === null) {
            m.module = { exports: {} };
            m.factory.call(m.module.exports, m.module, m.module.exports, require_module, rt.api);
        }
        return m.module.exports;
    }

    /*
     * not_bundled(name) -> a stand-in that explains why an API is missing
     */
    function not_bundled(name) {
        return function () {
            throw new Error('Moss: ' + name + ' is not bundled into "' + ctx.info.name + '". Mention it in the script or force the feature in the script options.');
        };
    }

    /*
     * start(main) — run the user's script once everything it needs is ready
     */
    function start(main) {
        const ready = Promise.all(rt.waits).catch(report);
        rt.moss.ready = ready;

        /*
         * run() — call main with one argument per API name
         */
        function run() {
            try {
                const args = [];
                for (const name of ctx.params) {
                    if (ctx.aliases[name] !== undefined) {
                        args.push(require_module(ctx.aliases[name]));
                    } else if (name in rt.api) {
                        args.push(rt.api[name]);
                    } else {
                        args.push(not_bundled(name));
                    }
                }
                Promise.resolve(main.apply(g, args)).catch(report);
            } catch (e) {
                report(e);
            }
        }

        /*
         * go() — run now, or after the configured delay
         */
        function go() {
            if (ctx.delay) {
                setTimeout(run, ctx.delay);
            } else {
                run();
            }
        }

        // Exported background scripts start synchronously so chrome.* listeners are
        // registered on the service worker's first turn (required to be woken by events).
        if (ctx.sync) {
            go();
        } else {
            ready.then(go);
        }
    }

    rt.log = log;
    rt.report = report;
    rt.call = call;
    rt.on_push = on_push;
    rt.reconnected = reconnected;
    rt.define = define;
    rt.require = require_module;
    rt.start = start;

    const info = { script: ctx.info, scriptHandler: 'Moss', version: ctx.version, sandboxMode: ctx.mode };
    rt.api.GM_info = info;
    rt.gm.info = info;
    rt.api.GM_log = log;
    rt.gm.log = log;
    rt.api.unsafeWindow = g;
    rt.api.GM = rt.gm;
    rt.api.require = require_module;
    rt.moss = { id: ctx.id, mode: ctx.mode, target: ctx.target, features: ctx.features, log: log, ready: null };
    rt.api.moss = rt.moss;
    return rt;
}
