/*
 * Host feature: audio — GM_audio: mute state of the script's own tab, and pushes
 * "audio" messages to the script when its tab is muted, unmuted, starts or stops
 * playing sound. Needs no permission: muting and audible state are not "tabs" data.
 */
moss_host_features.audio = function (host) {
    'use strict';

    /*
     * own_tab(conn) -> the script's tab id, or throws for background scripts
     */
    function own_tab(conn) {
        if (conn.tab_id === null || conn.tab_id === undefined) {
            throw new Error('Moss: GM_audio only works in a script that runs in a tab');
        }
        return conn.tab_id;
    }

    /*
     * state_of(tab) -> { isMuted, muteReason, isAudible } like Tampermonkey's
     */
    function state_of(tab) {
        const info = tab.mutedInfo || {};
        let reason = null;
        if (info.muted) {
            reason = info.reason === 'user' ? 'user' : (info.reason === 'capture' ? 'capture' : 'extension');
        }
        return { isMuted: !!info.muted, muteReason: reason, isAudible: !!tab.audible };
    }

    host.handlers['audio.set_mute'] = async function (conn, script, args) {
        await chrome.tabs.update(own_tab(conn), { muted: !!args[0] });
        return true;
    };

    host.handlers['audio.get_state'] = async function (conn) {
        return state_of(await chrome.tabs.get(own_tab(conn)));
    };

    host.handlers['audio.watch'] = function (conn) {
        const tab_id = own_tab(conn);
        if (conn.subs.has('audio')) {
            return true;
        }
        /*
         * on_updated(id, change) — forward mute / sound changes of the script's tab
         */
        function on_updated(id, change) {
            if (id !== tab_id || (change.mutedInfo === undefined && change.audible === undefined)) {
                return;
            }
            const out = {};
            if (change.mutedInfo !== undefined) {
                out.muted = change.mutedInfo.muted ? (change.mutedInfo.reason || 'extension') : false;
            }
            if (change.audible !== undefined) {
                out.audible = change.audible;
            }
            conn.send({ push: 'audio', change: out });
        }
        chrome.tabs.onUpdated.addListener(on_updated);
        conn.subs.set('audio', function () {
            chrome.tabs.onUpdated.removeListener(on_updated);
        });
        return true;
    };

    host.handlers['audio.unwatch'] = function (conn) {
        const unsubscribe = conn.subs.get('audio');
        if (unsubscribe !== undefined) {
            unsubscribe();
            conn.subs.delete('audio');
        }
        return true;
    };
};
