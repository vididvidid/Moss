/*
 * Feature: audio — GM_audio (Tampermonkey 5): mute or unmute the script's own tab and
 * watch its sound state.
 *     GM_audio.setMute({ isMuted }, done)           done(error | undefined)
 *     GM_audio.getState(fn)                         fn({ isMuted, muteReason, isAudible })
 *     GM_audio.addStateChangeListener(fn, done)     fn({ muted?, audible? }) on each change
 *     GM_audio.removeStateChangeListener(fn, done)
 * GM.audio has the same methods returning promises.
 */
(function () {
    'use strict';
    const listeners = [];

    rt.push.audio = function (msg) {
        for (const fn of listeners.slice()) {
            try {
                fn(msg.change);
            } catch (e) {
                rt.report(e);
            }
        }
    };
    rt.resync.push(function () {
        if (listeners.length > 0) {
            rt.call('audio.watch').catch(rt.report);
        }
    });

    /*
     * finish(promise, done) -> promise; also calls done(error | undefined, value) if given
     */
    function finish(promise, done) {
        if (typeof done === 'function') {
            promise.then(function (value) {
                done(undefined, value);
            }, function (e) {
                done(String(e.message || e));
            });
        }
        return promise;
    }

    /*
     * set_mute(details) -> Promise, mutes the tab when details.isMuted
     */
    function set_mute(details) {
        return rt.call('audio.set_mute', [!!(details && details.isMuted)]);
    }

    /*
     * add_listener(fn) -> Promise, starts watching the first time
     */
    function add_listener(fn) {
        if (typeof fn !== 'function') {
            return Promise.reject(new Error('GM_audio.addStateChangeListener needs a function'));
        }
        listeners.push(fn);
        return listeners.length === 1 ? rt.call('audio.watch') : Promise.resolve();
    }

    /*
     * remove_listener(fn) -> Promise, stops watching after the last one
     */
    function remove_listener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) {
            listeners.splice(i, 1);
        }
        return listeners.length === 0 ? rt.call('audio.unwatch') : Promise.resolve();
    }

    rt.api.GM_audio = {
        setMute: function (details, done) {
            finish(set_mute(details), done).catch(function (e) {
                if (typeof done !== 'function') {
                    rt.report(e);
                }
            });
        },
        getState: function (fn) {
            rt.call('audio.get_state').then(function (state) {
                if (typeof fn === 'function') {
                    fn(state);
                }
            }).catch(rt.report);
        },
        addStateChangeListener: function (fn, done) {
            finish(add_listener(fn), done).catch(rt.report);
        },
        removeStateChangeListener: function (fn, done) {
            finish(remove_listener(fn), done).catch(rt.report);
        },
    };
    rt.gm.audio = {
        setMute: set_mute,
        getState: function () {
            return rt.call('audio.get_state');
        },
        addStateChangeListener: add_listener,
        removeStateChangeListener: remove_listener,
    };
})();
