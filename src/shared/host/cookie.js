/*
 * Host feature: cookie — GM_cookie.list / set / delete through chrome.cookies.
 * policy.cookies: 'all' | 'no_httponly' (default) | 'none'.
 */
moss_host_features.cookie = function (host) {
    'use strict';

    /*
     * check(script) -> chrome.cookies, after the grant and policy checks
     */
    function check(script) {
        host.require_grant(script, ['GM_cookie', 'GM.cookie'], 'GM_cookie');
        if (host.policy.cookies === 'none') {
            throw new Error('Moss: cookie access is switched off (Settings → Security)');
        }
        if (!chrome.cookies) {
            throw new Error('Moss: GM_cookie needs the "cookies" permission — open the script and click Save to grant it');
        }
        return chrome.cookies;
    }

    /*
     * url_of(conn, details) -> the URL the call is about
     */
    function url_of(conn, details) {
        if (details.url) {
            return String(details.url);
        }
        if (details.domain) {
            return 'https://' + String(details.domain).replace(/^\./, '') + (details.path || '/');
        }
        if (conn.url) {
            return conn.url;
        }
        throw new Error('Moss: GM_cookie needs a url or domain here');
    }

    host.handlers['cookie.list'] = async function (conn, script, args) {
        const cookies = check(script);
        const details = args[0] || {};
        const query = {};
        if (details.domain) {
            query.domain = String(details.domain);
        } else {
            query.url = url_of(conn, details);
        }
        if (details.name) {
            query.name = String(details.name);
        }
        if (details.path) {
            query.path = String(details.path);
        }
        const all = await cookies.getAll(query);
        const out = [];
        for (const c of all) {
            if (c.httpOnly && host.policy.cookies !== 'all') {
                continue;
            }
            out.push({
                domain: c.domain, name: c.name, value: c.value, path: c.path, secure: c.secure,
                httpOnly: c.httpOnly, hostOnly: c.hostOnly, session: c.session,
                expirationDate: c.expirationDate, sameSite: c.sameSite,
            });
        }
        return out;
    };

    host.handlers['cookie.set'] = async function (conn, script, args) {
        const cookies = check(script);
        const details = args[0] || {};
        if (details.httpOnly && host.policy.cookies !== 'all') {
            throw new Error('Moss: setting HttpOnly cookies is not allowed (Settings → Security)');
        }
        const set = { url: url_of(conn, details), name: String(details.name), value: String(details.value === undefined ? '' : details.value) };
        const copy = ['domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite'];
        for (const key of copy) {
            if (details[key] !== undefined) {
                set[key] = details[key];
            }
        }
        await cookies.set(set);
        return true;
    };

    host.handlers['cookie.delete'] = async function (conn, script, args) {
        const cookies = check(script);
        const details = args[0] || {};
        await cookies.remove({ url: url_of(conn, details), name: String(details.name) });
        return true;
    };
};
