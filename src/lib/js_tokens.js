'use strict';
/*
 * A small JavaScript tokenizer for the dashboard editor: syntax colouring and the
 * auto-formatter both read code through it. It never fails: anything it does not
 * recognise becomes a one-character "punct" token, so joining every token's text
 * always gives back the input exactly.
 *
 * struct token {
 *     type: 'space' | 'newline' | 'comment' | 'block' | 'string' | 'template' |
 *           'regex' | 'number' | 'word' | 'punct';
 *     text: string;
 *     start: number;     offset in the code
 * }
 */

// Longest first, so ">>>=" wins over ">>" and ">".
const PUNCTS = [
    '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '**', '<<', '>>',
];

// After these words a "/" starts a regex, not a division.
const REGEX_AFTER_WORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await'];

export const KEYWORDS = ['await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if',
    'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
    'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'];
export const LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];

const NUMBER_RE = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
const WORD_RE = /#?[A-Za-z_$ -￿][\w$ -￿]*/y;
const SPACE_RE = /[ \t\f\v ﻿]+/y;

/*
 * token_create(type, text, start) -> struct token
 */
function token_create(type, text, start) {
    return { type: type, text: text, start: start };
}

/*
 * regex_allowed(prev) -> true if a "/" after the significant token prev starts a regex
 */
export function regex_allowed(prev) {
    if (prev === null) {
        return true;
    }
    if (prev.type === 'word') {
        return REGEX_AFTER_WORDS.indexOf(prev.text) >= 0;
    }
    if (prev.type === 'punct') {
        return prev.text !== ')' && prev.text !== ']' && prev.text !== '}';
    }
    return false;
}

/*
 * quoted_end(src, i) -> index just past the string literal starting at i
 */
function quoted_end(src, i) {
    const quote = src[i];
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (c === quote || c === '\n') {
            return c === quote ? j + 1 : j;
        }
        j++;
    }
    return src.length;
}

/*
 * regex_end(src, i) -> index just past the regex literal (with flags) starting at i
 */
function regex_end(src, i) {
    let j = i + 1;
    let in_class = false;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (c === '\n') {
            return j;
        }
        if (c === '[') {
            in_class = true;
        } else if (c === ']') {
            in_class = false;
        } else if (c === '/' && !in_class) {
            j++;
            while (j < src.length && /[a-z]/i.test(src[j])) {
                j++;
            }
            return j;
        }
        j++;
    }
    return src.length;
}

/*
 * template_end(src, i) -> index just past the template literal starting at i,
 * including any ${ … } parts (which may hold strings and templates of their own)
 */
function template_end(src, i) {
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (c === '`') {
            return j + 1;
        }
        if (c === '$' && src[j + 1] === '{') {
            j = expression_end(src, j + 2);
            continue;
        }
        j++;
    }
    return src.length;
}

/*
 * expression_end(src, i) -> index just past the "}" closing a ${ … } part that starts at i
 */
function expression_end(src, i) {
    let depth = 0;
    let j = i;
    let prev = null;
    while (j < src.length) {
        const tok = read_token(src, j, prev);
        if (tok.type === 'punct' && tok.text === '{') {
            depth++;
        } else if (tok.type === 'punct' && tok.text === '}') {
            if (depth === 0) {
                return j + 1;
            }
            depth--;
        }
        if (tok.type !== 'space' && tok.type !== 'newline' && tok.type !== 'comment' && tok.type !== 'block') {
            prev = tok;
        }
        j += tok.text.length;
    }
    return src.length;
}

/*
 * sticky(re, src, i) -> the match of the sticky regex re at i, or null
 */
function sticky(re, src, i) {
    re.lastIndex = i;
    const m = re.exec(src);
    return m === null ? null : m[0];
}

/*
 * read_token(src, i, prev) -> the struct token starting at i; prev is the last
 * significant token (decides regex versus division)
 */
export function read_token(src, i, prev) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n' || c === '\r') {
        return token_create('newline', c === '\r' && next === '\n' ? '\r\n' : c, i);
    }
    const space = sticky(SPACE_RE, src, i);
    if (space !== null) {
        return token_create('space', space, i);
    }
    if (c === '/' && next === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) {
            j = src.length;
        }
        if (src[j - 1] === '\r') {
            j--;
        }
        return token_create('comment', src.slice(i, j), i);
    }
    if (c === '/' && next === '*') {
        const j = src.indexOf('*/', i + 2);
        return token_create('block', src.slice(i, j < 0 ? src.length : j + 2), i);
    }
    if (c === '"' || c === '\'') {
        return token_create('string', src.slice(i, quoted_end(src, i)), i);
    }
    if (c === '`') {
        return token_create('template', src.slice(i, template_end(src, i)), i);
    }
    if (c === '/' && regex_allowed(prev)) {
        return token_create('regex', src.slice(i, regex_end(src, i)), i);
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next || ''))) {
        const num = sticky(NUMBER_RE, src, i);
        if (num !== null) {
            return token_create('number', num, i);
        }
    }
    const word = sticky(WORD_RE, src, i);
    if (word !== null) {
        return token_create('word', word, i);
    }
    for (const p of PUNCTS) {
        if (src.startsWith(p, i)) {
            if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) {
                break; // "a ?.5 : b" is a ternary
            }
            return token_create('punct', p, i);
        }
    }
    return token_create('punct', c, i);
}

/*
 * is_significant(tok) -> false for whitespace and comments
 */
export function is_significant(tok) {
    return tok.type !== 'space' && tok.type !== 'newline' && tok.type !== 'comment' && tok.type !== 'block';
}

/*
 * tokenize(src) -> struct token[] covering all of src
 */
export function tokenize(src) {
    const out = [];
    let prev = null;
    let i = 0;
    while (i < src.length) {
        const tok = read_token(src, i, prev);
        out.push(tok);
        if (is_significant(tok)) {
            prev = tok;
        }
        i += tok.text.length;
    }
    return out;
}
