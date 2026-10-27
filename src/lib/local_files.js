'use strict';
/*
 * Scripts linked to a file on this computer (File System Access API). The dashboard
 * keeps each file's handle in IndexedDB and, while a Moss page is open, reloads the
 * script whenever the file changes — a live-reload workflow without @require file://,
 * which extensions cannot read.
 *
 * A linked script has source = { kind: 'local', url: 'local:<name>', label, hash, ... }.
 * The browser asks again for read access after a restart; reconnect() does that.
 */
const DB_NAME = 'moss-local-files';
const STORE = 'handles';

/*
 * open_db() -> Promise<IDBDatabase>
 */
function open_db() {
    return new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
            req.result.createObjectStore(STORE);
        };
        req.onsuccess = function () {
            resolve(req.result);
        };
        req.onerror = function () {
            reject(req.error);
        };
    });
}

/*
 * request_done(req) -> Promise of an IDBRequest's result
 */
function request_done(req) {
    return new Promise(function (resolve, reject) {
        req.onsuccess = function () {
            resolve(req.result);
        };
        req.onerror = function () {
            reject(req.error);
        };
    });
}

/*
 * with_store(mode, fn) -> Promise of fn(object_store)'s request result
 */
async function with_store(mode, fn) {
    const db = await open_db();
    try {
        return await request_done(fn(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
        db.close();
    }
}

/*
 * pick_file() -> FileSystemFileHandle chosen by the user (must run in a click handler)
 */
export async function pick_file() {
    const handles = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'JavaScript', accept: { 'text/javascript': ['.js', '.mjs', '.user.js'] } }],
    });
    return handles[0];
}

/*
 * save_handle(id, handle) — remember which file a script is linked to
 */
export function save_handle(id, handle) {
    return with_store('readwrite', function (store) {
        return store.put(handle, id);
    });
}

/*
 * load_handle(id) -> the script's FileSystemFileHandle, or undefined
 */
export function load_handle(id) {
    return with_store('readonly', function (store) {
        return store.get(id);
    });
}

/*
 * remove_handle(id) — forget a script's file
 */
export function remove_handle(id) {
    return with_store('readwrite', function (store) {
        return store.delete(id);
    });
}

/*
 * has_access(handle) -> true if the file can be read without asking
 */
export async function has_access(handle) {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted';
}

/*
 * reconnect(handle) -> true once the user allowed reading the file again (click handler)
 */
export async function reconnect(handle) {
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/*
 * read_file(handle) -> { text, modified }
 */
export async function read_file(handle) {
    const file = await handle.getFile();
    return { text: await file.text(), modified: file.lastModified };
}
