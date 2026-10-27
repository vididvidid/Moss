/*
 * Host feature: notify — chrome.notifications, with click/close routed back to the script.
 */
moss_host_features.notify = function (host) {
    'use strict';
    const owners = new Map(); // notification id -> { conn, id }

    if (chrome.notifications) {
        chrome.notifications.onClicked.addListener(function (notification_id) {
            const owner = owners.get(notification_id);
            if (owner !== undefined) {
                owner.conn.send({ push: 'notify', id: owner.id, kind: 'click' });
            }
        });
        chrome.notifications.onClosed.addListener(function (notification_id) {
            const owner = owners.get(notification_id);
            if (owner === undefined) {
                return;
            }
            owners.delete(notification_id);
            owner.conn.send({ push: 'notify', id: owner.id, kind: 'close' });
        });
    }

    host.handlers.notify = async function (conn, script, args) {
        const d = args[1] || {};
        const notification_id = await chrome.notifications.create({
            type: 'basic',
            iconUrl: d.image || host.opts.icon,
            title: String(d.title || script.name),
            message: String(d.text || ''),
            silent: !!d.silent,
        });
        owners.set(notification_id, { conn: conn, id: args[0] });
        return notification_id;
    };
};
