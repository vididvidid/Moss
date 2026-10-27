// Sandboxed page (see "sandbox" in manifest.json): receives one bundled script from
// the runner and evaluates it in global scope.
window.addEventListener('message', function onRun(e) {
  if (e.source !== window.parent || !e.data || !e.data.moss || typeof e.data.moss.run !== 'string') return;
  window.removeEventListener('message', onRun);
  (0, eval)(e.data.moss.run);
});
