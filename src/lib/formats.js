'use strict';
/*
 * Script formats. Moss reads two headers and can rewrite one as the other:
 *
 *   .moss  — Moss's own. Plain "key: value" lines, lists as "- item" lines, and strict
 *            mode unless it says "strict: off". New scripts made in Moss use it.
 *
 *       // ==Moss==
 *       // name:    Hide comments
 *       // match:
 *       //   - https://news.example.com/*
 *       //   - https://forum.example.com/*
 *       // use:     moss/ui/toast as toast
 *       // ==/Moss==
 *
 *   .user.js — the Tampermonkey / Violentmonkey "// ==UserScript==" header with
 *            "// @key value" lines. Accepted as is, so any userscript installs unchanged.
 *
 * Both share the same keys (name, match, grant, run-at, …), so converting keeps every
 * line, its order and its spelling.
 */
import { find_header, header_entries, is_list_key } from './meta.js';

export const FORMATS = ['moss', 'userscript'];
const KEY_WIDTH = 12;   // values line up after the longest common key

/*
 * script_format(code) -> 'moss' | 'userscript' | null when the code has no header
 */
export function script_format(code) {
    const header = find_header(code);
    return header === null ? null : header.format;
}

/*
 * file_extension(format) -> '.moss' or '.user.js'
 */
export function file_extension(format) {
    return format === 'moss' ? '.moss' : '.user.js';
}

/*
 * format_label(format) -> how the dashboard names a format
 */
export function format_label(format) {
    return format === 'moss' ? '.moss' : 'userscript';
}

/*
 * is_script_file(name) -> true for file names or URLs Moss can install
 */
export function is_script_file(name) {
    return /\.(user\.js|moss|moss\.js)(?:[?#].*)?$/i.test(name);
}

/*
 * pad(text, width) -> text followed by spaces up to width (at least one space)
 */
function pad(text, width) {
    return text.length >= width ? `${text} ` : text.padEnd(width);
}

/*
 * render_userscript(entries) -> a "// ==UserScript==" header
 */
export function render_userscript(entries) {
    let out = '// ==UserScript==\n';
    for (const entry of entries) {
        const line = entry.value === '' ? `// @${entry.key}` : `// ${pad(`@${entry.key}`, KEY_WIDTH + 2)}${entry.value}`;
        out += `${line}\n`;
    }
    return `${out}// ==/UserScript==`;
}

/*
 * render_moss(entries) -> a "// ==Moss==" header. A list key that repeats becomes one
 * "key:" line with "- item" lines under it, placed where the key first appeared.
 */
export function render_moss(entries) {
    const count = {};
    for (const entry of entries) {
        const key = entry.key.toLowerCase();
        count[key] = (count[key] || 0) + 1;
    }
    const done = {};
    let out = '// ==Moss==\n';
    for (const entry of entries) {
        const key = entry.key.toLowerCase();
        if (done[key]) {
            continue;
        }
        if (is_list_key(key) && count[key] > 1) {
            done[key] = true;
            out += `// ${entry.key}:\n`;
            for (const item of entries) {
                if (item.key.toLowerCase() === key) {
                    out += `//   - ${item.value}\n`;
                }
            }
            continue;
        }
        out += entry.value === '' ? `// ${entry.key}:\n` : `// ${pad(`${entry.key}:`, KEY_WIDTH)}${entry.value}\n`;
    }
    return `${out}// ==/Moss==`;
}

/*
 * find_entry(entries, key) -> the first entry named key (lower case), or null
 */
function find_entry(entries, key) {
    for (const entry of entries) {
        if (entry.key.toLowerCase() === key) {
            return entry;
        }
    }
    return null;
}

/*
 * strict_off(value) -> true when a "strict" value switches strict mode off
 */
function strict_off(value) {
    return value === 'off' || value === 'false' || value === 'no';
}

/*
 * convert_entries(entries, from, to) -> entries that keep the script's behaviour in the
 * other format. Only strict mode differs: on by default in .moss, off in userscripts.
 */
function convert_entries(entries, from, to) {
    const out = [];
    const strict = find_entry(entries, 'strict');
    for (const entry of entries) {
        if (entry.key.toLowerCase() === 'strict' && to === 'userscript' && strict_off(entry.value)) {
            continue; // userscripts are sloppy unless they say @strict
        }
        out.push({ key: entry.key, value: entry.value });
    }
    if (from === 'userscript' && to === 'moss' && strict === null) {
        out.push({ key: 'strict', value: 'off' });
    }
    if (from === 'moss' && to === 'userscript' && strict === null) {
        out.push({ key: 'strict', value: '' });
    }
    return out;
}

/*
 * convert_format(code, to) -> code with its header rewritten in format to ('moss' or
 * 'userscript'); the rest of the code is untouched. Throws without a header.
 */
export function convert_format(code, to) {
    const header = find_header(code);
    if (header === null) {
        throw new Error('This script has no header to convert.');
    }
    if (header.format === to) {
        return code;
    }
    const entries = convert_entries(header_entries(code).entries, header.format, to);
    const block = to === 'moss' ? render_moss(entries) : render_userscript(entries);
    return code.slice(0, header.start) + block + code.slice(header.end);
}
