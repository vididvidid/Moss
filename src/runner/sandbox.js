'use strict';
/*
 * Sandboxed page (see "sandbox" in manifest.json): receives one bundled script from
 * the runner and evaluates it. Indirect eval runs it in global scope and in sloppy
 * mode, so only scripts that ask for strict mode get it.
 */

/*
 * on_run(event) — run the script the runner sent, once
 */
function on_run(event) {
    const msg = event.data && event.data.moss;
    if (event.source !== window.parent || !msg || typeof msg.run !== 'string') {
        return;
    }
    window.removeEventListener('message', on_run);
    const indirect_eval = eval;
    indirect_eval(msg.run);
}

window.addEventListener('message', on_run);
