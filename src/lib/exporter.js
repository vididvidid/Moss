'use strict';
/*
 * Turns one script into a standalone MV3 extension containing only what it uses:
 * the runtime files for its features, the host files for its privileged features,
 * the permissions those need, and a popup only when it has menu commands.
 *
 * struct export_file { path: string; content: string | Uint8Array; reason: string; }
 * struct export_result { plan: struct plan; manifest: object; files: struct export_file[]; }
 */
import { build, build_relay, plan, slugify, MOSS_VERSION } from './bundler.js';
import { HOST_CORE, host_feature } from '../shared/features.js';
import { host_policy } from './settings.js';

const ICON_SIZES = [16, 48, 128];
const POPUP_HTML = 'src/export/popup.html';
const POPUP_JS = 'src/export/popup.js';

/*
 * chrome_version(version) -> a version Chrome accepts: up to 4 numbers, each ≤ 65535
 */
function chrome_version(version) {
    const numbers = [];
    for (const part of String(version || '').split(/[.-]/)) {
        const n = parseInt(part, 10);
        if (Number.isFinite(n) && n >= 0 && numbers.length < 4) {
            numbers.push(Math.min(n, 65535));
        }
    }
    return numbers.length > 0 ? numbers.join('.') : '0.1.0';
}

/*
 * pick(choice, setting, fallback) -> the export dialog's choice, else the setting, else fallback
 */
function pick(choice, setting, fallback) {
    if (choice !== undefined && choice !== null) {
        return choice;
    }
    if (setting !== undefined && setting !== null) {
        return setting;
    }
    return fallback;
}

/*
 * names_of(list) -> the .name of each item
 */
function names_of(list) {
    const out = [];
    for (const item of list) {
        out.push(item.name);
    }
    return out;
}

/*
 * export_extension(script, { sources, settings, choices }) -> struct export_result
 *
 * choices (from the export dialog, all optional):
 *   name, version, description, features: { <feature>: 'include' | 'exclude' },
 *   include_source, include_readme, manifest (an edited manifest that replaces the generated one)
 */
export async function export_extension(script, args) {
    const sources = args.sources;
    const settings = args.settings || {};
    const choices = args.choices || {};
    const options = Object.assign({}, script.options);
    options.features = Object.assign({}, options.features, choices.features);
    const scoped = Object.assign({}, script, { options: options });

    const p = await plan(scoped, { sources: sources, settings: settings, target: 'export' });
    if (p.errors.length > 0) {
        throw new Error(p.errors.join('\n'));
    }
    const meta = p.meta;
    const name = choices.name || meta.name;
    const description = pick(choices.description, null, meta.description);
    const files = [];

    /*
     * add(path, content, reason) — put one file in the export
     */
    function add(path, content, reason) {
        files.push({ path: path, content: content, reason: reason });
    }

    // A page-mode script with a bridge talks to its relay through a secret channel name.
    const channel = p.transport === 'relay' ? crypto.randomUUID() : '';
    const code = await build(p, { sources: sources, script: scoped, token: channel, settings: settings });
    const needs_background = p.mode === 'extension' || p.host_features.length > 0;

    const icons = {};
    for (const size of ICON_SIZES) {
        icons[size] = `icons/icon${size}.png`;
    }
    let manifest = {
        manifest_version: 3,
        name: name,
        version: chrome_version(choices.version || meta.version),
        description: description.slice(0, 132),
        icons: icons,
        action: { default_title: name, default_icon: { 16: 'icons/icon16.png', 48: 'icons/icon48.png' } },
    };
    if (meta.homepage) {
        manifest.homepage_url = meta.homepage;
    }
    if (p.permissions.length > 0) {
        manifest.permissions = names_of(p.permissions);
    }
    if (p.host_permissions.length > 0) {
        manifest.host_permissions = names_of(p.host_permissions);
    }

    if (p.mode !== 'extension') {
        const t = p.targets;
        const world = (p.mode === 'page' || p.inject === 'raw') ? 'MAIN' : 'ISOLATED';
        manifest.content_scripts = [];
        if (p.transport === 'relay') {
            manifest.content_scripts.push(content_script_entry(t, 'relay.js', 'document_start', 'ISOLATED'));
            add('relay.js', await build_relay(p, { sources: sources, script: scoped, token: channel }), 'bridge between the page-mode script and the extension');
        }
        manifest.content_scripts.push(content_script_entry(t, 'content.js', p.inject_at, world));
        const used = names_of(p.features);
        add('content.js', code, `the script (${p.mode} world${used.length > 0 ? ' + ' + used.join(', ') : ''})`);
    }

    if (needs_background) {
        manifest.background = { service_worker: 'background.js' };
        const reason = p.mode === 'extension' ? 'the background script' : `privileged side of: ${p.host_features.join(', ')}`;
        add('background.js', await background_source(p, scoped, code, sources, settings), reason);
    }

    if (p.needs_popup) {
        manifest.action.default_popup = 'popup.html';
        add('popup.html', await sources.text(POPUP_HTML), 'menu commands');
        add('popup.js', await sources.text(POPUP_JS), 'menu commands');
    }

    for (const size of ICON_SIZES) {
        add(`icons/icon${size}.png`, await sources.binary(`icons/icon${size}.png`), 'extension icon');
    }

    if (choices.manifest) {
        manifest = choices.manifest;
    }
    if (pick(choices.include_source, settings['export.include_source'], true)) {
        add(`source/${slugify(meta.name)}.user.js`, script.code, 'original userscript (not loaded by the browser)');
        for (const mod of p.modules) {
            add(`source/modules/${mod.name}.js`, mod.src, 'module source (not loaded, already bundled)');
        }
    }
    if (pick(choices.include_readme, settings['export.include_readme'], true)) {
        add('README.md', readme(manifest, p, files), 'how to load and publish');
    }
    files.unshift({ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n', reason: 'extension manifest' });
    return { plan: p, manifest: manifest, files: files };
}

/*
 * content_script_entry(t, file, run_at, world) -> one manifest content_scripts entry on targets t
 */
function content_script_entry(t, file, run_at, world) {
    const entry = { matches: t.matches, js: [file], run_at: run_at, all_frames: t.all_frames, world: world };
    if (t.exclude_matches.length > 0) {
        entry.exclude_matches = t.exclude_matches;
    }
    if (t.include_globs.length > 0) {
        entry.include_globs = t.include_globs;
    }
    if (t.exclude_globs.length > 0) {
        entry.exclude_globs = t.exclude_globs;
    }
    return entry;
}

/*
 * background_source(p, script, code, sources, settings) -> background.js of the export
 */
async function background_source(p, script, code, sources, settings) {
    const out = [`// ${p.meta.name} — background service worker generated by Moss ${MOSS_VERSION}`];
    if (p.host_features.length > 0) {
        out.push(await sources.text(HOST_CORE));
        for (const name of p.host_features) {
            out.push(await sources.text(host_feature(name)));
        }
        const info = { id: script.id, name: p.meta.name, grants: p.meta.grant, connect: p.meta.connect };
        const policy = Object.assign(host_policy(settings), { chrome_namespaces: null });
        const init = [
            '(function () {',
            '    \'use strict\';',
            '    const SCRIPT = ' + JSON.stringify(info) + ';',
            '    const host = moss_host({',
            '        icon: chrome.runtime.getURL(\'icons/icon128.png\'),',
            '        policy: ' + JSON.stringify(policy) + ',',
            '        get_script: async function () {',
            '            return SCRIPT;',
            '        },',
            '    });',
        ];
        if (p.mode === 'extension') {
            init.push('    globalThis.moss_host_instance = host;');
        } else {
            init.push(
                '    chrome.runtime.onConnect.addListener(function (port) {',
                '        if (!port.sender || port.sender.id !== chrome.runtime.id || !port.name.startsWith(\'moss:\')) {',
                '            return;',
                '        }',
                '        const tab_id = port.sender.tab ? port.sender.tab.id : null;',
                '        host.attach_port(port, { script_id: SCRIPT.id, tab_id: tab_id, url: port.sender.url });',
                '    });');
        }
        if (p.needs_popup) {
            init.push(
                '    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {',
                '        if (sender.id !== chrome.runtime.id || sender.tab || !msg) {',
                '            return;',
                '        }',
                '        if (msg.type === \'menu.list\') {',
                '            respond(host.list_menus(msg.tab_id));',
                '        } else if (msg.type === \'menu.run\') {',
                '            respond(host.run_menu(msg.conn, msg.id));',
                '        }',
                '    });');
        }
        init.push('})();');
        out.push(init.join('\n'));
    }
    if (p.mode === 'extension') {
        out.push(code);
    }
    return out.join('\n\n') + '\n';
}

/*
 * readme(manifest, p, files) -> README.md of the export
 */
function readme(manifest, p, files) {
    const file_rows = [];
    for (const f of files) {
        file_rows.push(`| \`${f.path}\` | ${f.reason} |`);
    }
    const permission_rows = [];
    for (const x of p.permissions.concat(p.host_permissions)) {
        permission_rows.push(`- \`${x.name}\` — ${x.reason}`);
    }
    return `# ${manifest.name}

${manifest.description || ''}

Exported from a [Moss](https://github.com/vididvidid/Moss) userscript. It runs on its own: Moss is not needed.

## Try it
1. Open \`chrome://extensions\` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.

## Publish it
Zip this folder (with \`manifest.json\` at the root) and upload it at https://chrome.google.com/webstore/devconsole.
Swap the icons in \`icons/\` for your own first.

## Permissions
${permission_rows.length > 0 ? permission_rows.join('\n') : '- none'}

## Files
| file | why it is here |
|---|---|
${file_rows.join('\n')}
`;
}
