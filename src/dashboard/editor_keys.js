'use strict';
/*
 * Keyboard shortcuts for the dashboard's code editor (a plain textarea). The defaults
 * follow Tampermonkey's Windows key map; Settings → Editor → Custom shortcuts adds or
 * replaces bindings with lines like "Ctrl-Shift-K = delete_line" ("= none" frees a key).
 * Edits go through document.execCommand('insertText') so Ctrl-Z can undo them.
 *
 * struct editor_ctx {              what a command may use
 *     el: HTMLTextAreaElement;
 *     indent: string;             one level: spaces or "\t"
 *     save();                     save the open item
 *     ask(question, value) -> string | null;   prompt for text
 *     search: { query, replacement }; remembered between finds
 * }
 */

// Key (canonical form, see canon_key) -> command name.
export const DEFAULT_KEYS = {
    'Tab': 'indent_or_tab',
    'Shift-Tab': 'indent_less',
    'Ctrl-]': 'indent_more',
    'Ctrl-[': 'indent_less',
    'Alt-Up': 'move_line_up',
    'Alt-Down': 'move_line_down',
    'Ctrl-D': 'delete_line',
    'Ctrl-Shift-D': 'duplicate_lines',
    'Ctrl-K': 'toggle_comment',
    'Ctrl-/': 'toggle_comment',
    'Ctrl-Shift-K': 'toggle_block_comment',
    'Ctrl-M': 'matching_bracket',
    'Ctrl-J': 'jump_to_line',
    'Ctrl-F': 'find',
    'Ctrl-G': 'find_next',
    'F3': 'find_next',
    'Ctrl-Shift-G': 'find_previous',
    'Shift-F3': 'find_previous',
    'Ctrl-Shift-F': 'replace',
    'Ctrl-R': 'replace',
    'Ctrl-Shift-R': 'replace_all',
    'Ctrl-S': 'save',
    'Ctrl-Z': 'undo',
    'Ctrl-U': 'undo',
    'Ctrl-Y': 'redo',
    'Ctrl-Shift-Z': 'redo',
    'Alt-U': 'redo',
};

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const KEY_ALIASES = {
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down',
    left: 'Left', right: 'Right', escape: 'Esc', esc: 'Esc', ' ': 'Space', space: 'Space', tab: 'Tab',
    enter: 'Enter', backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown', cmd: 'Meta', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt',
    shift: 'Shift', meta: 'Meta',
};

/*
 * key_part(name) -> the canonical spelling of one key name
 */
function key_part(name) {
    const alias = KEY_ALIASES[name.toLowerCase()];
    if (alias !== undefined) {
        return alias;
    }
    if (/^f\d{1,2}$/i.test(name)) {
        return name.toUpperCase();
    }
    return name.length === 1 ? name.toUpperCase() : name;
}

/*
 * canon_key(text) -> "Ctrl-Alt-Shift-Meta-Key" order for a written shortcut such as
 * "Shift-Ctrl-d" or "ctrl+shift+d"
 */
export function canon_key(text) {
    const parts = String(text).trim().split(/(?<=.)[-+](?=.)/);
    const mods = [];
    let key = '';
    for (const raw of parts) {
        const part = key_part(raw.trim());
        const mod = part === 'Control' ? 'Ctrl' : part;
        if (MODIFIERS.indexOf(mod) >= 0) {
            mods.push(mod);
        } else {
            key = part;
        }
    }
    const out = [];
    for (const mod of MODIFIERS) {
        if (mods.indexOf(mod) >= 0) {
            out.push(mod);
        }
    }
    out.push(key);
    return out.join('-');
}

/*
 * event_key(event) -> the canonical shortcut of a keydown event
 */
export function event_key(event) {
    const out = [];
    if (event.ctrlKey) {
        out.push('Ctrl');
    }
    if (event.altKey) {
        out.push('Alt');
    }
    if (event.shiftKey) {
        out.push('Shift');
    }
    if (event.metaKey) {
        out.push('Meta');
    }
    let key = event.key;
    // With Shift held, "/" arrives as "?" and "]" as "}": use the physical key instead.
    if (event.code && /^(Key[A-Z]|Digit\d|Bracket(Left|Right)|Slash)$/.test(event.code)) {
        const CODES = { BracketLeft: '[', BracketRight: ']', Slash: '/' };
        key = CODES[event.code] !== undefined ? CODES[event.code] : event.code.slice(-1);
    }
    out.push(key_part(key));
    return out.join('-');
}

/*
 * keymap(custom_lines) -> { key: command } — the defaults with the user's lines applied.
 * Bad lines are returned in errors so the settings page can point at them.
 */
export function keymap(custom_lines) {
    const map = Object.assign({}, DEFAULT_KEYS);
    const errors = [];
    for (const line of custom_lines || []) {
        const m = /^\s*(.+?)\s*=\s*([a-z_]+)\s*$/.exec(line);
        if (m === null || (m[2] !== 'none' && COMMANDS[m[2]] === undefined)) {
            errors.push(line);
            continue;
        }
        const key = canon_key(m[1]);
        if (m[2] === 'none') {
            delete map[key];
        } else {
            map[key] = m[2];
        }
    }
    return { map: map, errors: errors };
}

// ---------- text helpers ----------

/*
 * line_range(el) -> { start, end } offsets covering every line the selection touches
 * (end is before the last line's newline)
 */
function line_range(el) {
    const text = el.value;
    const start = text.lastIndexOf('\n', el.selectionStart - 1) + 1;
    let last = el.selectionEnd;
    if (last > el.selectionStart && text[last - 1] === '\n') {
        last--; // a selection ending at a line start doesn't include that line
    }
    let end = text.indexOf('\n', last);
    if (end < 0) {
        end = text.length;
    }
    return { start: start, end: end };
}

/*
 * replace_range(el, start, end, text, sel_start, sel_end) — replace text (undoable) and select
 */
function replace_range(el, start, end, text, sel_start, sel_end) {
    el.focus();
    el.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
        el.setRangeText(text, start, end, 'end');
        el.dispatchEvent(new Event('input'));
    }
    el.setSelectionRange(sel_start, sel_end);
}

/*
 * map_lines(ctx, fn) — replace each selected line with fn(line), keeping them selected
 */
function map_lines(ctx, fn) {
    const el = ctx.el;
    const r = line_range(el);
    const lines = el.value.slice(r.start, r.end).split('\n');
    const out = [];
    for (const line of lines) {
        out.push(fn(line));
    }
    const text = out.join('\n');
    replace_range(el, r.start, r.end, text, r.start, r.start + text.length);
}

/*
 * select_match(el, from, to) — select a found match and scroll it into view
 */
function select_match(el, from, to) {
    el.focus();
    el.setSelectionRange(from, to);
    const line = el.value.slice(0, from).split('\n').length - 1;
    const line_height = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, line * line_height - el.clientHeight / 3);
}

/*
 * find_from(ctx, backwards) -> true if the remembered query was found and selected
 */
function find_from(ctx, backwards) {
    const el = ctx.el;
    const query = ctx.search.query;
    if (!query) {
        return false;
    }
    const text = el.value;
    let at = -1;
    if (backwards) {
        at = text.lastIndexOf(query, el.selectionStart - 1);
        if (at < 0) {
            at = text.lastIndexOf(query); // wrap around
        }
    } else {
        at = text.indexOf(query, el.selectionEnd);
        if (at < 0) {
            at = text.indexOf(query);
        }
    }
    if (at < 0) {
        return false;
    }
    select_match(el, at, at + query.length);
    return true;
}

// ---------- commands ----------

/*
 * move_lines(ctx, up) — move the selected lines one line up or down
 */
function move_lines(ctx, up) {
    const el = ctx.el;
    const text = el.value;
    const r = line_range(el);
    const block = text.slice(r.start, r.end);
    if (up) {
        if (r.start === 0) {
            return;
        }
        const prev_start = text.lastIndexOf('\n', r.start - 2) + 1;
        const prev = text.slice(prev_start, r.start - 1);
        replace_range(el, prev_start, r.end, block + '\n' + prev, prev_start, prev_start + block.length);
        return;
    }
    if (r.end >= text.length) {
        return;
    }
    let next_end = text.indexOf('\n', r.end + 1);
    if (next_end < 0) {
        next_end = text.length;
    }
    const next = text.slice(r.end + 1, next_end);
    const at = r.start + next.length + 1;
    replace_range(el, r.start, next_end, next + '\n' + block, at, at + block.length);
}

export const COMMANDS = {
    indent_or_tab: {
        label: 'Indent the selected lines, or insert an indent',
        run: function (ctx) {
            const el = ctx.el;
            if (el.value.slice(el.selectionStart, el.selectionEnd).indexOf('\n') >= 0) {
                COMMANDS.indent_more.run(ctx);
                return;
            }
            replace_range(el, el.selectionStart, el.selectionEnd, ctx.indent,
                el.selectionStart + ctx.indent.length, el.selectionStart + ctx.indent.length);
        },
    },
    indent_more: {
        label: 'Indent more',
        run: function (ctx) {
            map_lines(ctx, function (line) {
                return ctx.indent + line;
            });
        },
    },
    indent_less: {
        label: 'Indent less',
        run: function (ctx) {
            map_lines(ctx, function (line) {
                if (line.startsWith('\t')) {
                    return line.slice(1);
                }
                const spaces = /^ */.exec(line)[0].length;
                return line.slice(Math.min(spaces, ctx.indent === '\t' ? 4 : ctx.indent.length));
            });
        },
    },
    move_line_up: {
        label: 'Move line up',
        run: function (ctx) {
            move_lines(ctx, true);
        },
    },
    move_line_down: {
        label: 'Move line down',
        run: function (ctx) {
            move_lines(ctx, false);
        },
    },
    delete_line: {
        label: 'Delete line',
        run: function (ctx) {
            const el = ctx.el;
            const r = line_range(el);
            const end = r.end < el.value.length ? r.end + 1 : r.end;
            const start = r.end >= el.value.length && r.start > 0 ? r.start - 1 : r.start;
            replace_range(el, start, end, '', start, start);
        },
    },
    duplicate_lines: {
        label: 'Duplicate lines',
        run: function (ctx) {
            const el = ctx.el;
            const r = line_range(el);
            const block = el.value.slice(r.start, r.end);
            const at = r.end + 1;
            replace_range(el, r.end, r.end, '\n' + block, at, at + block.length);
        },
    },
    toggle_comment: {
        label: 'Toggle // comment',
        run: function (ctx) {
            const el = ctx.el;
            const r = line_range(el);
            const lines = el.value.slice(r.start, r.end).split('\n');
            let all_commented = true;
            for (const line of lines) {
                if (line.trim() !== '' && !/^\s*\/\//.test(line)) {
                    all_commented = false;
                }
            }
            map_lines(ctx, function (line) {
                if (all_commented) {
                    return line.replace(/^(\s*)\/\/ ?/, '$1');
                }
                return line.trim() === '' ? line : line.replace(/^(\s*)/, '$1// ');
            });
        },
    },
    toggle_block_comment: {
        label: 'Toggle /* block comment */',
        run: function (ctx) {
            const el = ctx.el;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const picked = el.value.slice(start, end);
            const m = /^\/\*\s?([\s\S]*?)\s?\*\/$/.exec(picked);
            const text = m !== null ? m[1] : '/* ' + picked + ' */';
            replace_range(el, start, end, text, start, start + text.length);
        },
    },
    matching_bracket: {
        label: 'Jump to the matching bracket',
        run: function (ctx) {
            const el = ctx.el;
            const text = el.value;
            const PAIRS = { '(': ')', '[': ']', '{': '}' };
            const BACK = { ')': '(', ']': '[', '}': '{' };
            let at = el.selectionStart;
            if (PAIRS[text[at]] === undefined && BACK[text[at]] === undefined) {
                at--;
            }
            const ch = text[at];
            if (PAIRS[ch] === undefined && BACK[ch] === undefined) {
                return;
            }
            const forward = PAIRS[ch] !== undefined;
            const other = forward ? PAIRS[ch] : BACK[ch];
            let depth = 0;
            for (let i = at; i >= 0 && i < text.length; i += forward ? 1 : -1) {
                if (text[i] === ch) {
                    depth++;
                } else if (text[i] === other) {
                    depth--;
                    if (depth === 0) {
                        select_match(el, i, i);
                        return;
                    }
                }
            }
        },
    },
    jump_to_line: {
        label: 'Jump to line',
        run: function (ctx) {
            const answer = ctx.ask('Go to line:', '');
            const n = parseInt(answer, 10);
            if (!(n > 0)) {
                return;
            }
            const lines = ctx.el.value.split('\n');
            let offset = 0;
            for (let i = 0; i < Math.min(n - 1, lines.length - 1); i++) {
                offset += lines[i].length + 1;
            }
            select_match(ctx.el, offset, offset);
        },
    },
    find: {
        label: 'Find',
        run: function (ctx) {
            const el = ctx.el;
            const picked = el.value.slice(el.selectionStart, el.selectionEnd);
            const answer = ctx.ask('Find:', picked && picked.indexOf('\n') < 0 ? picked : ctx.search.query);
            if (answer === null || answer === '') {
                return;
            }
            ctx.search.query = answer;
            el.setSelectionRange(el.selectionStart, el.selectionStart);
            if (!find_from(ctx, false)) {
                ctx.ask('Not found: ' + answer, null);
            }
        },
    },
    find_next: {
        label: 'Find next',
        run: function (ctx) {
            if (!ctx.search.query) {
                COMMANDS.find.run(ctx);
                return;
            }
            find_from(ctx, false);
        },
    },
    find_previous: {
        label: 'Find previous',
        run: function (ctx) {
            find_from(ctx, true);
        },
    },
    replace: {
        label: 'Replace the next match',
        run: function (ctx) {
            const query = ctx.ask('Replace:', ctx.search.query);
            if (!query) {
                return;
            }
            const replacement = ctx.ask('With:', ctx.search.replacement);
            if (replacement === null) {
                return;
            }
            ctx.search.query = query;
            ctx.search.replacement = replacement;
            const el = ctx.el;
            if (el.value.slice(el.selectionStart, el.selectionEnd) !== query) {
                el.setSelectionRange(el.selectionStart, el.selectionStart);
                if (!find_from(ctx, false)) {
                    return;
                }
            }
            const start = el.selectionStart;
            replace_range(el, start, el.selectionEnd, replacement, start, start + replacement.length);
            find_from(ctx, false);
        },
    },
    replace_all: {
        label: 'Replace all',
        run: function (ctx) {
            const query = ctx.ask('Replace all:', ctx.search.query);
            if (!query) {
                return;
            }
            const replacement = ctx.ask('With:', ctx.search.replacement);
            if (replacement === null) {
                return;
            }
            ctx.search.query = query;
            ctx.search.replacement = replacement;
            const el = ctx.el;
            const text = el.value.split(query).join(replacement);
            replace_range(el, 0, el.value.length, text, 0, 0);
        },
    },
    save: {
        label: 'Save',
        run: function (ctx) {
            ctx.save();
        },
    },
    undo: {
        label: 'Undo',
        run: function () {
            document.execCommand('undo');
        },
    },
    redo: {
        label: 'Redo',
        run: function () {
            document.execCommand('redo');
        },
    },
};

/*
 * trim_trailing(text) -> text without spaces or tabs at the end of its lines
 */
export function trim_trailing(text) {
    return text.replace(/[ \t]+$/gm, '');
}
