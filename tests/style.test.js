'use strict';
/*
 * Style checker for STYLE.md. Zero dependencies: a small scanner blanks out
 * comments, strings, template text and regex literals (keeping line breaks),
 * then each rule looks at what is left — real code only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const SCAN_DIRS = ['src', 'tests', 'tools'];
const INJECTED_DIRS = ['src/shared/runtime/', 'src/shared/host/'];
const BANNED_METHODS = ['map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find', 'findIndex', 'flatMap'];
const SNAKE = /^[a-z_$][a-z0-9_$]*$/;
const UPPER = /^[A-Z][A-Z0-9_]*$/;
// After one of these, a "/" starts a regex literal rather than a division.
const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw'];

/*
 * list_files(dir) -> every .js/.mjs file under dir (recursive)
 */
function list_files(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (name !== 'node_modules') {
                out.push(...list_files(path));
            }
        } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
            out.push(path);
        }
    }
    return out;
}

/*
 * previous_word(code, i) -> the identifier ending just before index i (or '')
 */
function previous_word(code, i) {
    let end = i;
    while (end > 0 && /\s/.test(code[end - 1])) {
        end--;
    }
    let start = end;
    while (start > 0 && /[\w$]/.test(code[start - 1])) {
        start--;
    }
    return code.slice(start, end);
}

/*
 * regex_allowed(out) -> true when a "/" at the end of out starts a regex literal
 */
function regex_allowed(out) {
    let i = out.length - 1;
    while (i >= 0 && /\s/.test(out[i])) {
        i--;
    }
    if (i < 0) {
        return true;
    }
    if (REGEX_AFTER.includes(out[i])) {
        return true;
    }
    return REGEX_AFTER_WORDS.includes(previous_word(out, i + 1));
}

/*
 * blank(text) -> text with every character except newlines turned into a space
 */
function blank(text) {
    return text.replace(/[^\n]/g, ' ');
}

// Template text is blanked with this marker instead of spaces, so the layout rule
// can tell "text inside a template literal" apart from indentation.
const TEMPLATE_TEXT = '\u0001';

/*
 * blank_template(text) -> text with every character except newlines turned into TEMPLATE_TEXT
 */
function blank_template(text) {
    return text.replace(/[^\n]/g, TEMPLATE_TEXT);
}

/*
 * strip(src) -> src with comments, string/template text and regex literals blanked.
 * Quotes are kept so the shape of the code survives; ${...} code inside templates
 * is kept too, since it is real code.
 */
function strip(src) {
    let out = '';
    let i = 0;
    const template_depth = []; // brace depth at each open ${ … }
    let depth = 0;

    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];

        if (c === '/' && next === '/') {
            const end = src.indexOf('\n', i);
            const stop = end < 0 ? src.length : end;
            out += blank(src.slice(i, stop));
            i = stop;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            out += blank(src.slice(i, stop));
            i = stop;
            continue;
        }
        if (c === '\'' || c === '"') {
            let j = i + 1;
            while (j < src.length && src[j] !== c && src[j] !== '\n') {
                j += src[j] === '\\' ? 2 : 1;
            }
            out += c + blank(src.slice(i + 1, j)) + c;
            i = j + 1;
            continue;
        }
        if (c === '`' || (c === '}' && template_depth.length > 0 && template_depth[template_depth.length - 1] === depth)) {
            // Template text runs until the closing ` or the next ${.
            if (c === '}') {
                template_depth.pop();
            }
            let j = i + 1;
            while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) {
                j += src[j] === '\\' ? 2 : 1;
            }
            out += c + blank_template(src.slice(i + 1, j));
            if (src[j] === '$') {
                out += '${';
                template_depth.push(depth);
                i = j + 2;
            } else {
                out += '`';
                i = j + 1;
            }
            continue;
        }
        if (c === '/' && regex_allowed(out)) {
            let j = i + 1;
            let in_class = false;
            while (j < src.length && src[j] !== '\n') {
                if (src[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (src[j] === '[') {
                    in_class = true;
                } else if (src[j] === ']') {
                    in_class = false;
                } else if (src[j] === '/' && !in_class) {
                    break;
                }
                j++;
            }
            while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) {
                j++;
            }
            out += '/' + blank(src.slice(i + 1, j)) + '/';
            i = j + 1;
            continue;
        }
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
        }
        out += c;
        i++;
    }
    return out;
}

/*
 * line_of(text, index) -> 1-based line number of index
 */
function line_of(text, index) {
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (text[i] === '\n') {
            line++;
        }
    }
    return line;
}

/*
 * matching_paren(code, open) -> index of the ")" closing the "(" at open
 */
function matching_paren(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') {
            depth++;
        } else if (code[i] === ')') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/*
 * next_code_char(code, i) -> index of the first non-space character at or after i
 */
function next_code_char(code, i) {
    while (i < code.length && /\s/.test(code[i])) {
        i++;
    }
    return i;
}

/*
 * check_strict(path, src, code, report) — rule 1
 */
function check_strict(path, src, code, report) {
    const first = next_code_char(code, 0);
    const at_top = src.startsWith('\'use strict\';', first);
    if (path.endsWith('.user.js')) {
        // Userscripts opt in through their header; Moss adds the directive when bundling.
        if (!/^\s*\/\/\s*@strict\s*$/m.test(src)) {
            report(1, 'userscript: add "// @strict" to the header');
        }
        return;
    }
    let injected = false;
    for (const dir of INJECTED_DIRS) {
        if (path.startsWith(dir)) {
            injected = true;
        }
    }
    if (!injected) {
        if (!at_top) {
            report(line_of(code, first), "first statement must be 'use strict';");
        }
        return;
    }
    if (at_top) {
        report(line_of(code, first), "injected file: put 'use strict' inside the function, not at file level");
        return;
    }
    const open = code.indexOf('{', first);
    const body = next_code_char(code, open + 1);
    if (open < 0 || !src.startsWith('\'use strict\';', body)) {
        report(line_of(code, first), "injected file: the first statement inside the top-level function must be 'use strict';");
        return;
    }
    // Exactly one top-level construct: brace depth returns to zero only at the end.
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') {
            depth++;
        } else if (code[i] === '}') {
            depth--;
            if (depth === 0) {
                const rest = code.slice(i + 1).replace(/[\s();]/g, '');
                if (rest !== '') {
                    report(line_of(code, i), 'injected file: only one top-level function or IIFE allowed (code after it would run sloppy)');
                }
                return;
            }
        }
    }
}

/*
 * check_tokens(code, report) — rules 3, 4 and 6: arrows, array methods, var, ?. and ??
 */
function check_tokens(code, report) {
    const rules = [
        [/=>/g, 'no arrow functions — use function declarations'],
        [new RegExp(`\\.(${BANNED_METHODS.join('|')})\\s*\\(`, 'g'), 'no array iteration methods — write a for loop'],
        [/\bvar\b/g, 'no var — use const or let'],
        [/\?\.(?!\d)/g, 'no optional chaining — check for null explicitly'],
        [/\?\?/g, 'no ?? — check for null explicitly'],
    ];
    for (const [pattern, message] of rules) {
        for (const m of code.matchAll(pattern)) {
            report(line_of(code, m.index), `${message} (${m[0].trim()})`);
        }
    }
}

/*
 * check_braces(code, report) — rule 5: if/else/for/while always take a { block }
 */
function check_braces(code, report) {
    for (const m of code.matchAll(/\b(if|for|while|else)\b/g)) {
        if (code[m.index - 1] === '.') {
            continue;
        }
        const keyword = m[1];
        let after = next_code_char(code, m.index + keyword.length);
        if (keyword === 'else') {
            if (code[after] !== '{' && !code.startsWith('if', after)) {
                report(line_of(code, m.index), 'else needs braces');
            }
            continue;
        }
        if (keyword === 'for' && code.startsWith('await', after)) {
            after = next_code_char(code, after + 5);
        }
        if (code[after] !== '(') {
            continue;
        }
        const close = matching_paren(code, after);
        const body = next_code_char(code, close + 1);
        // do { … } while (x); has no body of its own.
        const is_do_while = keyword === 'while' && code[previous_brace(code, m.index)] === '}' && code[body] === ';';
        if (code[body] !== '{' && !is_do_while) {
            report(line_of(code, m.index), `${keyword} needs braces`);
        }
    }
}

/*
 * previous_brace(code, i) -> index of the last non-space character before i
 */
function previous_brace(code, i) {
    let j = i - 1;
    while (j > 0 && /\s/.test(code[j])) {
        j--;
    }
    return j;
}

/*
 * check_layout(code, report) — rule 5: 4-space indentation, no tabs
 */
function check_layout(code, report) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '' || line.trimStart().startsWith(TEMPLATE_TEXT)) {
            continue;
        }
        if (line.includes('\t')) {
            report(i + 1, 'tab character — indent with spaces');
            continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent % 4 !== 0) {
            report(i + 1, `indent of ${indent} spaces — use multiples of 4`);
        }
    }
}

/*
 * check_name(name, line, report) — rule 2 for one declared name
 */
function check_name(name, line, report) {
    if (name === '' || SNAKE.test(name) || UPPER.test(name)) {
        return;
    }
    report(line, `"${name}" is not snake_case or UPPER_SNAKE`);
}

/*
 * check_names(code, report) — rule 2: declarations, function names and parameters
 */
function check_names(code, report) {
    for (const m of code.matchAll(/\b(?:let|const)\s+([A-Za-z_$][\w$]*)/g)) {
        check_name(m[1], line_of(code, m.index), report);
    }
    for (const m of code.matchAll(/\b(?:let|const)\s*[{[]([^}\]=]*)[}\]]\s*=/g)) {
        for (const part of m[1].split(',')) {
            const local = part.split(':').pop().split('=')[0].replace('...', '').trim();
            check_name(local, line_of(code, m.index), report);
        }
    }
    for (const m of code.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
        const line = line_of(code, m.index);
        check_name(m[1] || '', line, report);
        const open = m.index + m[0].length - 1;
        const params = code.slice(open + 1, matching_paren(code, open));
        for (const part of params.split(',')) {
            const name = part.split('=')[0].replace('...', '').trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) {
                check_name(name, line, report);
            }
        }
    }
    for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
        check_name(m[1], line_of(code, m.index), report);
    }
}

/*
 * check_function_docs(src, report) — rule 3: a comment right above each named function
 */
function check_function_docs(src, report) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*(export\s+)?(async\s+)?function\s+[\w$]+\s*\(/.test(lines[i])) {
            continue;
        }
        let j = i - 1;
        while (j >= 0 && lines[j].trim() === '') {
            j--;
        }
        const above = j >= 0 ? lines[j].trim() : '';
        if (!above.endsWith('*/') && !above.startsWith('//')) {
            report(i + 1, 'named function needs a comment above it: name(args) -> result');
        }
    }
}

/*
 * check_file(path, src) -> list of "path:line  message" strings
 */
export function check_file(path, src) {
    const problems = [];
    const code = strip(src);
    /*
     * report(line, message) — collect one problem
     */
    function report(line, message) {
        problems.push(`${path}:${line}  ${message}`);
    }
    check_strict(path, src, code, report);
    check_tokens(code, report);
    check_braces(code, report);
    check_layout(code, report);
    check_names(code, report);
    check_function_docs(src, report);
    return problems;
}

test('every file follows STYLE.md', function () {
    const problems = [];
    for (const dir of SCAN_DIRS) {
        for (const file of list_files(join(ROOT, dir))) {
            const path = relative(ROOT, file);
            problems.push(...check_file(path, readFileSync(file, 'utf8')));
        }
    }
    assert.equal(problems.length, 0, `${problems.length} style problem(s):\n${problems.join('\n')}`);
});

test('the checker itself catches each rule', function () {
    const bad = [
        "const fooBar = 1;",
        "items.map(function (x) { return x; });",
        "const f = (x) => x;",
        "var a = 1;",
        "if (a) b();",
        "const c = a?.b ?? 2;",
        "  const d = 1;",
        "function helper() {}",
    ].join('\n');
    const problems = check_file('src/lib/example.js', bad).join('\n');
    assert.match(problems, /first statement must be 'use strict'/);
    assert.match(problems, /"fooBar" is not snake_case/);
    assert.match(problems, /no array iteration methods/);
    assert.match(problems, /no arrow functions/);
    assert.match(problems, /no var/);
    assert.match(problems, /if needs braces/);
    assert.match(problems, /no optional chaining/);
    assert.match(problems, /no \?\?/);
    assert.match(problems, /indent of 2 spaces/);
    assert.match(problems, /needs a comment above it/);

    const good = "'use strict';\nconst s = 'a => b ?? c?.d var';\nconst r = /x=>y/g;\n/*\n * ok() -> 1\n */\nfunction ok() {\n    return `${s} => ${r}`;\n}\n";
    assert.deepEqual(check_file('src/lib/fine.js', good), []);

    const injected_top = "'use strict';\n(function () {\n})();\n";
    assert.match(check_file('src/shared/runtime/x.js', injected_top).join(), /inside the function/);
    const injected_ok = "/* x */\n(function () {\n    'use strict';\n})();\n";
    assert.deepEqual(check_file('src/shared/runtime/x.js', injected_ok), []);
    const injected_two = "(function () {\n    'use strict';\n})();\nfoo();\n";
    assert.match(check_file('src/shared/runtime/x.js', injected_two).join(), /only one top-level/);
});
