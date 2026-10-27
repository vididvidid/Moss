'use strict';
/*
 * chrome.storage.local layout (schema_version 2):
 *   scripts  { [id]: struct script }
 *   modules  { [name]: { name, code, updated_at } }   — names like "utils/text"
 *   settings { [key]: value }                         — see settings.js
 *   moss_enabled: boolean                             — global on/off; missing = on
 *   trash    { [id]: { script, values, deleted_at } } — deleted scripts, restorable
 *   tokens   { [id]: secret }                         — authenticates script ports
 *   updates  { [id]: { checked_at, status, error, version, updated_at } } — see updater.js
 *   values:<id>                                       — a script's GM values
 *   schema_version: 2                                 — see migrate.js
 *
 * struct script {
 *     id: string;
 *     code: string;
 *     enabled: boolean;
 *     options: { [key]: value };   per-script overrides, see SCRIPT_OPTIONS
 *     source: struct source | null; where it was imported from, see updater.js
 *     created_at, updated_at: number;
 * }
 */
const AREA = chrome.storage.local;

/*
 * read(key, fallback) -> the stored value of key, or fallback when missing
 */
async function read(key, fallback) {
    const got = await AREA.get(key);
    if (got[key] === undefined || got[key] === null) {
        return fallback;
    }
    return got[key];
}

/*
 * load_scripts() -> { [id]: struct script }
 */
export function load_scripts() {
    return read('scripts', {});
}

/*
 * load_modules() -> { [name]: { name, code, updated_at } }
 */
export function load_modules() {
    return read('modules', {});
}

/*
 * load_settings_raw() -> only the settings the user changed (see resolve_settings)
 */
export function load_settings_raw() {
    return read('settings', {});
}

/*
 * load_moss_enabled() -> false only when Moss was switched off from the dashboard
 */
export async function load_moss_enabled() {
    return (await read('moss_enabled', true)) !== false;
}

/*
 * save_moss_enabled(on) — switch every script on or off at once, keeping each one's own toggle
 */
export async function save_moss_enabled(on) {
    await AREA.set({ moss_enabled: on });
}

/*
 * load_updates() -> { [id]: last update check }
 */
export function load_updates() {
    return read('updates', {});
}

/*
 * new_id() -> a fresh script id such as "s3f9c0a1b2c4d"
 */
export function new_id() {
    return 's' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/*
 * put_script(script) -> the stored struct script (created or replaced)
 */
export async function put_script(script) {
    const scripts = await load_scripts();
    scripts[script.id] = Object.assign({ options: {}, source: null }, script, { updated_at: Date.now() });
    await AREA.set({ scripts: scripts });
    return scripts[script.id];
}

/*
 * patch_script(id, patch) -> the updated struct script, or null if id is unknown
 */
export async function patch_script(id, patch) {
    const scripts = await load_scripts();
    if (scripts[id] === undefined) {
        return null;
    }
    scripts[id] = Object.assign({}, scripts[id], patch, { updated_at: Date.now() });
    await AREA.set({ scripts: scripts });
    return scripts[id];
}

/*
 * remove_script(id) — delete a script and its stored values
 */
export async function remove_script(id) {
    const scripts = await load_scripts();
    delete scripts[id];
    await AREA.set({ scripts: scripts });
    await AREA.remove(`values:${id}`);
}

/*
 * load_trash() -> { [id]: { script, values, deleted_at } }
 */
export function load_trash() {
    return read('trash', {});
}

/*
 * trash_script(id) — move a script and its values to the trash
 */
export async function trash_script(id) {
    const scripts = await load_scripts();
    if (scripts[id] === undefined) {
        return;
    }
    const trash = await load_trash();
    trash[id] = { script: scripts[id], values: await load_values(id), deleted_at: Date.now() };
    delete scripts[id];
    await AREA.set({ scripts: scripts, trash: trash });
    await AREA.remove(`values:${id}`);
}

/*
 * restore_script(id) -> the restored struct script, or null if it is not in the trash
 */
export async function restore_script(id) {
    const trash = await load_trash();
    const item = trash[id];
    if (item === undefined) {
        return null;
    }
    const scripts = await load_scripts();
    scripts[id] = item.script;
    delete trash[id];
    const patch = { scripts: scripts, trash: trash };
    patch[`values:${id}`] = item.values || {};
    await AREA.set(patch);
    return item.script;
}

/*
 * purge_trash(id) — delete one trashed script for good, or every one when id is null
 */
export async function purge_trash(id) {
    const trash = await load_trash();
    if (id === null) {
        await AREA.set({ trash: {} });
        return;
    }
    delete trash[id];
    await AREA.set({ trash: trash });
}

/*
 * put_module(name, code) — create or replace a user module
 */
export async function put_module(name, code) {
    const modules = await load_modules();
    modules[name] = { name: name, code: code, updated_at: Date.now() };
    await AREA.set({ modules: modules });
}

/*
 * remove_module(name) — delete a user module
 */
export async function remove_module(name) {
    const modules = await load_modules();
    delete modules[name];
    await AREA.set({ modules: modules });
}

/*
 * save_settings(settings) — store the settings object
 */
export async function save_settings(settings) {
    await AREA.set({ settings: settings });
}

/*
 * tokens_for(ids) -> { [id]: secret }, creating a secret for each id that has none
 */
export async function tokens_for(ids) {
    const tokens = await read('tokens', {});
    let changed = false;
    for (const id of ids) {
        if (tokens[id] === undefined) {
            tokens[id] = crypto.randomUUID();
            changed = true;
        }
    }
    if (changed) {
        await AREA.set({ tokens: tokens });
    }
    return tokens;
}

/*
 * load_values(id) -> a script's GM values
 */
export function load_values(id) {
    return read(`values:${id}`, {});
}

/*
 * save_values(id, values) — replace a script's GM values
 */
export async function save_values(id, values) {
    const patch = {};
    patch[`values:${id}`] = values;
    await AREA.set(patch);
}

/*
 * record_update(id, info) — remember the last update check of a script. Kept apart from
 * `scripts` so a check doesn't trigger a rebuild of every script.
 */
export async function record_update(id, info) {
    const updates = await load_updates();
    updates[id] = Object.assign({}, updates[id], info, { checked_at: Date.now() });
    await AREA.set({ updates: updates });
}
