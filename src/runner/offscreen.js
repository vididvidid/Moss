'use strict';
/*
 * Background runner: one sandboxed iframe per extension-mode script. The iframe can
 * eval (sandbox CSP) but has no chrome.* access; this page relays its API calls to
 * the service worker over a port named after the script.
 *
 * struct frame { iframe: HTMLIFrameElement; code: string; port: Port | null; }
 */
const FRAMES = new Map(); // script id -> struct frame
let keepalive_timer = null;

/*
 * port_for(id, frame) -> the frame's port to the service worker, connecting if needed
 */
function port_for(id, frame) {
    if (frame.port !== null) {
        return frame.port;
    }
    const port = chrome.runtime.connect({ name: `moss-bg:${id}` });
    port.onMessage.addListener(function (msg) {
        if (frame.iframe.contentWindow) {
            frame.iframe.contentWindow.postMessage({ moss: msg }, '*');
        }
    });
    port.onDisconnect.addListener(function () {
        if (frame.port !== port) {
            return;
        }
        frame.port = null;
        if (frame.iframe.contentWindow) {
            frame.iframe.contentWindow.postMessage({ moss: { disconnected: true } }, '*');
        }
    });
    frame.port = port;
    return port;
}

/*
 * spawn(id, code) — start one script in a new sandboxed iframe
 */
function spawn(id, code) {
    const iframe = document.createElement('iframe');
    iframe.src = 'sandbox.html';
    iframe.dataset.script = id;
    iframe.addEventListener('load', function () {
        iframe.contentWindow.postMessage({ moss: { run: code } }, '*');
    }, { once: true });
    document.body.append(iframe);
    FRAMES.set(id, { iframe: iframe, code: code, port: null });
}

/*
 * ping_all() — port traffic keeps the service worker awake, so event listeners keep firing
 */
function ping_all() {
    for (const frame of FRAMES.values()) {
        if (frame.port !== null) {
            frame.port.postMessage({ ping: 1 });
        }
    }
}

/*
 * load(job) — make the running scripts match job.scripts ([{ id, code }])
 */
function load(job) {
    const next = new Map();
    for (const s of job.scripts) {
        next.set(s.id, s.code);
    }
    for (const [id, frame] of FRAMES) {
        if (next.get(id) === frame.code) {
            continue;
        }
        if (frame.port !== null) {
            frame.port.disconnect();
        }
        frame.iframe.remove();
        FRAMES.delete(id);
    }
    for (const [id, code] of next) {
        if (!FRAMES.has(id)) {
            spawn(id, code);
        }
    }
    clearInterval(keepalive_timer);
    if (job.keepalive) {
        keepalive_timer = setInterval(ping_all, 20000);
    }
}

/*
 * on_frame_message(event) — forward an API call from a script's iframe to its port
 */
function on_frame_message(event) {
    const msg = event.data && event.data.moss;
    if (!msg || msg.id === undefined) {
        return;
    }
    for (const [id, frame] of FRAMES) {
        if (frame.iframe.contentWindow === event.source) {
            port_for(id, frame).postMessage(msg);
            return;
        }
    }
}

/*
 * main() — ask the service worker which scripts to run
 */
async function main() {
    window.addEventListener('message', on_frame_message);
    chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.target === 'runner' && msg.type === 'load') {
            load(msg.value);
        }
    });
    const res = await chrome.runtime.sendMessage({ type: 'runner.scripts' });
    if (res && res.ok) {
        load(res.value);
    }
}

main();
