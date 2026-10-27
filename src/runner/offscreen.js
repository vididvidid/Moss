// Background runner: one sandboxed iframe per extension-mode script. The iframe can
// eval (sandbox CSP) but has no chrome.* access; this page relays its API calls to
// the service worker over a port named after the script.
const frames = new Map(); // id -> { iframe, code, port }
let keepalive = null;

function portFor(id, f) {
  if (f.port) return f.port;
  const port = chrome.runtime.connect({ name: `moss-bg:${id}` });
  port.onMessage.addListener((msg) => f.iframe.contentWindow?.postMessage({ moss: msg }, '*'));
  port.onDisconnect.addListener(() => {
    if (f.port !== port) return;
    f.port = null;
    f.iframe.contentWindow?.postMessage({ moss: { disconnected: true } }, '*');
  });
  f.port = port;
  return port;
}

function spawn(id, code) {
  const iframe = document.createElement('iframe');
  iframe.src = 'sandbox.html';
  iframe.dataset.script = id;
  iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ moss: { run: code } }, '*'), { once: true });
  document.body.append(iframe);
  frames.set(id, { iframe, code, port: null });
}

function load({ scripts, keepalive: keep }) {
  const next = new Map(scripts.map((s) => [s.id, s.code]));
  for (const [id, f] of frames) {
    if (next.get(id) === f.code) continue;
    f.port?.disconnect();
    f.iframe.remove();
    frames.delete(id);
  }
  for (const [id, code] of next) if (!frames.has(id)) spawn(id, code);

  // Port traffic keeps the service worker awake, so event listeners keep firing.
  clearInterval(keepalive);
  if (keep) keepalive = setInterval(() => frames.forEach((f) => f.port?.postMessage({ ping: 1 })), 20000);
}

window.addEventListener('message', (e) => {
  const msg = e.data?.moss;
  if (!msg || msg.id === undefined) return;
  for (const [id, f] of frames) {
    if (f.iframe.contentWindow === e.source) return portFor(id, f).postMessage(msg);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'runner' && msg.type === 'load') load(msg.value);
});

const res = await chrome.runtime.sendMessage({ type: 'runner.scripts' });
if (res?.ok) load(res.value);
