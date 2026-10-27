'use strict';
/*
 * Storage migrations. Version 1 (Moss 0.1.0) stored camelCase keys; version 2 stores
 * snake_case keys, like the rest of the code. migrate_state() is pure so it can run on
 * live storage, on an old backup, and in tests alike.
 */
import { sha256 } from './updater.js';

export const SCHEMA_VERSION = 2;

const SETTING_RENAMES = {
    'new.runAt': 'new.run_at',
    'security.chromeNamespaces': 'security.chrome_namespaces',
    'security.requireGrants': 'security.require_grants',
    'security.requireConnect': 'security.require_connect',
    'runtime.logErrors': 'runtime.log_errors',
    'runtime.logPrefix': 'runtime.log_prefix',
    'runtime.valuesBackend': 'runtime.values_backend',
    'update.autoByDefault': 'update.auto_by_default',
    'update.requireNewerVersion': 'update.require_newer_version',
    'update.overwriteLocal': 'update.overwrite_local',
    'editor.fontSize': 'editor.font_size',
    'editor.tabSize': 'editor.tab_size',
    'export.includeSource': 'export.include_source',
    'export.includeReadme': 'export.include_readme',
    'export.reviewManifest': 'export.review_manifest',
};
const FIELD_RENAMES = { createdAt: 'created_at', updatedAt: 'updated_at', checkedAt: 'checked_at', runAt: 'run_at', allFrames: 'all_frames' };

// Examples shipped with 0.1.0 (SHA-256 of their code) → the file that replaces them.
// Only untouched copies are replaced; edited ones are left alone.
export const EXAMPLE_UPGRADES = {
    b798c9b587c15ef1fcdb8c85b55297a6a3fd4e2fa7c625487434599c804d3a2a: 'src/examples/page-tools.user.js',
    '7d7adb4b91f7bf2cdace8585cfd16e95c23cab9e365873622594ef93794156c5': 'src/examples/fetch-logger.user.js',
    c4a6c56215f4b15e8a4eb457702dce1df49cc511689452b0cf595c5daa70be79: 'src/examples/utils-text.js',
};

/*
 * rename_fields(object) -> a copy of object with v1 field names replaced (one level deep)
 */
function rename_fields(object) {
    if (object === null || typeof object !== 'object') {
        return object;
    }
    const out = {};
    for (const key of Object.keys(object)) {
        const new_key = FIELD_RENAMES[key] !== undefined ? FIELD_RENAMES[key] : key;
        out[new_key] = object[key];
    }
    return out;
}

/*
 * migrate_state(data) -> { changed, data } where data holds the v2 form of the keys
 * scripts, modules, settings, updates and require_cache (others pass through untouched)
 */
export function migrate_state(data) {
    const version = data.schema_version || 1;
    if (version >= SCHEMA_VERSION) {
        return { changed: false, data: data };
    }
    const out = Object.assign({}, data, { schema_version: SCHEMA_VERSION });

    const scripts = {};
    for (const id of Object.keys(data.scripts || {})) {
        const script = rename_fields(data.scripts[id]);
        script.options = rename_fields(script.options || {});
        script.source = script.source ? rename_fields(script.source) : null;
        scripts[id] = script;
    }
    out.scripts = scripts;

    const modules = {};
    for (const name of Object.keys(data.modules || {})) {
        modules[name] = rename_fields(data.modules[name]);
    }
    out.modules = modules;

    const updates = {};
    for (const id of Object.keys(data.updates || {})) {
        updates[id] = rename_fields(data.updates[id]);
    }
    out.updates = updates;

    const settings = {};
    for (const key of Object.keys(data.settings || {})) {
        const new_key = SETTING_RENAMES[key] !== undefined ? SETTING_RENAMES[key] : key;
        settings[new_key] = data.settings[key];
    }
    out.settings = settings;

    if (data.requireCache !== undefined) {
        out.require_cache = data.requireCache;
        delete out.requireCache;
    }
    return { changed: true, data: out };
}

/*
 * upgrade_examples(scripts, modules, load_text) -> number of untouched 0.1.0 examples
 * replaced (in place) with their current version
 */
export async function upgrade_examples(scripts, modules, load_text) {
    let count = 0;
    for (const id of Object.keys(scripts)) {
        const path = EXAMPLE_UPGRADES[await sha256(scripts[id].code)];
        if (path !== undefined) {
            scripts[id].code = await load_text(path);
            count++;
        }
    }
    for (const name of Object.keys(modules)) {
        const path = EXAMPLE_UPGRADES[await sha256(modules[name].code)];
        if (path !== undefined) {
            modules[name].code = await load_text(path);
            count++;
        }
    }
    return count;
}
