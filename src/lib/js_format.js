'use strict';
/*
 * Auto-format for the dashboard editor. Deliberately conservative: it never joins or
 * splits lines (so it cannot change what automatic semicolon insertion does), and it
 * leaves strings, templates, regexes and comments as written. It does:
 *   - re-indent every line from its brackets (one level per line that opened any);
 *   - put "case" / "default" at the level of their "switch" (C / kernel style);
 *   - indent continuation lines (".then(…)", "&& b", a line after "a =") one more level;
 *   - tidy the spaces inside a line: "if (", ") {", "a, b", "a = b", "x: 1", no space
 *     before "," ";" or a call's "(";
 *   - drop trailing whitespace, keep at most opts.max_blank blank lines in a row, and
 *     end the file with one newline.
 *
 * struct format_opts {
 *     indent: string;      one level, e.g. "    " or "\t"
 *     spacing: boolean;    tidy spaces inside lines (false: only re-indent)
 *     max_blank: number;   blank lines kept in a row
 * }
 */
import { KEYWORDS, is_significant, read_token, tokenize } from './js_tokens.js';

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
// Binary operators that always get a space on both sides.
const SPACED = ['=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=',
    '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=', '=>', '**', '<<', '>>', '>>>', '&', '|', '^', '%'];
// Operators that are binary unless they follow another operator (then they are unary).
const MAYBE_UNARY = ['+', '-'];
// Binary when they follow a value; anything else ("import * as", "function*") is left as written.
const BINARY_AFTER_VALUE = ['*', '/'];
// A line ending in one of these continues on the next line.
const CONTINUES = ['=', '&&', '||', '??', '+', '-', '*', '/', '%', '?', ':', '=>', '+=', '-=', '*=', '/=', '||=', '&&=', '??='];
// A line starting with one of these continues the previous one.
const LEADING_CONTINUE = ['.', '?.', '&&', '||', '??', '+', '-', '*', '/', '?', ':'];
const SPACE_BEFORE_PAREN = ['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'async', 'yield', 'of', 'in', 'new', 'delete', 'void', 'throw', 'case', 'else', 'do'];
const SPACE_BEFORE_BRACE = ['else', 'try', 'finally', 'do'];
const AFTER_BRACE = ['else', 'catch', 'finally', 'while'];

/*
 * struct line {
 *     tokens: struct token[];     the line's tokens, no leading/trailing spaces
 *     gaps: string[];             gaps[i]: the whitespace written before tokens[i]
 * }
 */

/*
 * split_lines(tokens) -> struct line[]; a token holding line breaks (block comment,
 * template) stays on the line where it starts
 */
function split_lines(tokens) {
    const lines = [];
    let cur = { tokens: [], gaps: [] };
    let gap = '';
    for (const tok of tokens) {
        if (tok.type === 'newline') {
            lines.push(cur);
            cur = { tokens: [], gaps: [] };
            gap = '';
            continue;
        }
        if (tok.type === 'space') {
            gap = tok.text;
            continue;
        }
        cur.gaps.push(cur.tokens.length > 0 ? gap : '');
        cur.tokens.push(tok);
        gap = '';
    }
    lines.push(cur);
    return lines;
}

/*
 * is_punct(tok, text) -> true if tok is the punctuator text
 */
function is_punct(tok, text) {
    return tok !== null && tok !== undefined && tok.type === 'punct' && tok.text === text;
}

/*
 * is_unary_position(prev) -> true if an operator after prev is unary ("-x", "a = +b")
 */
function is_unary_position(prev) {
    if (prev === null) {
        return true;
    }
    if (prev.type === 'word') {
        return KEYWORDS.indexOf(prev.text) >= 0 && prev.text !== 'this' && prev.text !== 'super';
    }
    if (prev.type === 'punct') {
        return prev.text !== ')' && prev.text !== ']' && prev.text !== '}' && prev.text !== '++' && prev.text !== '--';
    }
    return false;
}

/*
 * would_merge(a, b, prev) -> true if writing b straight after a would read as other tokens
 * ("+" "+" → "++", "/" "/" → a comment, "a" "b" → "ab"); prev is the token before a
 */
function would_merge(a, b, prev) {
    const joined = a.text + b.text;
    const first = read_token(joined, 0, prev);
    return first.text.length !== a.text.length;
}

/*
 * gap_between(a, b, ctx) -> '' or ' ', the space to write between tokens a and b
 *   ctx: { gap: the whitespace written there; a_prev: token before a;
 *          a_role, b_role: from operator_role }
 */
function gap_between(a, b, ctx) {
    const original = ctx.gap === '' ? '' : ' ';
    if (b.type === 'comment') {
        return ctx.gap; // keeps trailing comments lined up
    }
    if (b.type === 'block' || a.type === 'block') {
        return original;
    }
    if (is_punct(b, ',') || is_punct(b, ';')) {
        return '';
    }
    if (is_punct(a, ',')) {
        return is_punct(b, ')') || is_punct(b, ']') ? '' : ' ';
    }
    if (is_punct(a, ';')) {
        return is_punct(b, ')') || is_punct(b, ';') ? original : ' ';
    }
    if (is_punct(a, '.') || is_punct(a, '?.') || is_punct(b, '.') || is_punct(b, '?.')) {
        return is_punct(b, '.') && a.type === 'number' ? original : '';
    }
    if (is_punct(a, '...') || is_punct(a, '!') || is_punct(a, '~')) {
        return '';
    }
    if ((is_punct(b, '++') || is_punct(b, '--')) && (a.type === 'word' || is_punct(a, ')') || is_punct(a, ']'))) {
        return ''; // i++
    }
    if ((is_punct(a, '++') || is_punct(a, '--')) && is_unary_position(ctx.a_prev)) {
        return ''; // ++i
    }
    if (is_punct(a, '{') && !is_punct(b, '}')) {
        return ' '; // { a: 1 } on one line
    }
    if (is_punct(b, '}') && !is_punct(a, '{')) {
        return ' ';
    }
    if (ctx.a_role === 'binary' || ctx.b_role === 'binary') {
        return ' ';
    }
    if (ctx.a_role === 'unary') {
        return '';
    }
    if (ctx.a_role === 'colon') {
        return ' ';
    }
    if (ctx.b_role === 'colon') {
        return '';
    }
    const a_is_property = is_punct(ctx.a_prev, '.') || is_punct(ctx.a_prev, '?.');
    if (is_punct(b, '(')) {
        if (a.type === 'word' && !a_is_property && SPACE_BEFORE_PAREN.indexOf(a.text) >= 0) {
            return ' ';
        }
        if (a.type === 'word' || is_punct(a, ')') || is_punct(a, ']')) {
            return '';
        }
    }
    if (is_punct(b, '{') && (is_punct(a, ')') || (a.type === 'word' && SPACE_BEFORE_BRACE.indexOf(a.text) >= 0))) {
        return ' ';
    }
    if (is_punct(a, '}') && b.type === 'word' && AFTER_BRACE.indexOf(b.text) >= 0) {
        return ' ';
    }
    if (is_punct(a, '(') || is_punct(a, '[') || is_punct(b, ')') || is_punct(b, ']')) {
        return '';
    }
    return original;
}

/*
 * operator_role(tok, prev, state, depth) -> 'binary' | 'unary' | 'colon' | null for one
 * token; keeps track of open "?" so a ternary ":" is told apart from "key:" / "case x:"
 */
function operator_role(tok, prev, state, depth) {
    if (tok.type !== 'punct') {
        return null;
    }
    if (tok.text === '?') {
        state.ternaries[depth] = (state.ternaries[depth] || 0) + 1;
        return 'binary';
    }
    if (tok.text === ':') {
        if (state.ternaries[depth] > 0) {
            state.ternaries[depth]--;
            return 'binary';
        }
        return 'colon';
    }
    if (SPACED.indexOf(tok.text) >= 0) {
        return 'binary';
    }
    if (MAYBE_UNARY.indexOf(tok.text) >= 0) {
        return is_unary_position(prev) ? 'unary' : 'binary';
    }
    if (BINARY_AFTER_VALUE.indexOf(tok.text) >= 0) {
        return is_unary_position(prev) ? null : 'binary';
    }
    return null;
}

/*
 * inner_level(stack) -> the level inside the innermost open bracket: one more than the
 * line that opened it, so "foo(function () {" indents its body once, not twice
 */
function inner_level(stack) {
    return stack.length === 0 ? 0 : stack[stack.length - 1].base + 1;
}

/*
 * reindent_block(text, indent, first_column) -> a multi-line block comment with its
 * later lines moved to the new indent (" * …" lines line up under the "/*")
 */
function reindent_block(text, indent, first_column) {
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        const trimmed = line.trim();
        if (trimmed === '') {
            lines[i] = '';
        } else if (trimmed.startsWith('*')) {
            lines[i] = `${indent} ${trimmed}`;
        } else {
            let cut = 0;
            while (cut < first_column && (line[cut] === ' ' || line[cut] === '\t')) {
                cut++;
            }
            lines[i] = indent + line.slice(cut).trimEnd();
        }
    }
    return lines.join('\n');
}

/*
 * column_of(src, tok) -> the column at which tok starts in src
 */
function column_of(src, tok) {
    const line_start = src.lastIndexOf('\n', tok.start - 1) + 1;
    return tok.start - line_start;
}

/*
 * format_js(src, opts) -> src re-indented and tidied (see the top of this file)
 */
export function format_js(src, opts) {
    const options = Object.assign({ indent: '    ', spacing: true, max_blank: 1 }, opts || {});
    const lines = split_lines(tokenize(src.replace(/\r\n/g, '\n')));
    const text = src.replace(/\r\n/g, '\n');
    const stack = [];            // { char, base: level of the line that opened it, is_switch }
    const state = { ternaries: [] };
    const out = [];
    let blank = 0;
    let prev_sig = null;         // last significant token of everything so far
    let prev_line_end = null;    // last significant token of the previous code line
    let prev_line_end_role = null;

    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        if (line.tokens.length === 0) {
            blank++;
            if (blank <= options.max_blank && out.length > 0) {
                out.push('');
            }
            continue;
        }
        blank = 0;

        // Leading closers belong to the level they close.
        // A line starting with closers goes back to the level of the line that opened them.
        const view = stack.slice();
        let k = 0;
        let closed = null;
        while (k < line.tokens.length && line.tokens[k].type === 'punct' && CLOSERS[line.tokens[k].text] !== undefined) {
            const popped = view.pop();
            if (popped !== undefined) {
                closed = popped;
            }
            k++;
        }
        let level = closed !== null ? closed.base : inner_level(view);
        const first = line.tokens[0];
        const inner = view.length > 0 ? view[view.length - 1] : null;
        const at_statement = inner === null || inner.char === '{';
        const is_case = inner !== null && inner.is_switch && first.type === 'word' && (first.text === 'case' || first.text === 'default');
        if (is_case) {
            level--;
        } else if (k === 0 && at_statement && is_significant(first)) {
            const leading = first.type === 'punct' && LEADING_CONTINUE.indexOf(first.text) >= 0;
            const trailing = prev_line_end !== null && prev_line_end.type === 'punct' && CONTINUES.indexOf(prev_line_end.text) >= 0
                && prev_line_end_role !== 'colon';
            if (leading || trailing) {
                level++;
            }
        }
        const indent = options.indent.repeat(Math.max(0, level));

        // Write the line, tracking brackets and spacing as we go.
        let body = '';
        let line_prev = null;
        let line_prev_role = null;
        let saw_switch = false;
        for (let i = 0; i < line.tokens.length; i++) {
            const tok = line.tokens[i];
            const role = is_significant(tok) ? operator_role(tok, prev_sig, state, stack.length) : null;
            let tok_text = tok.text;
            if (tok.type === 'block' && tok_text.indexOf('\n') >= 0) {
                tok_text = reindent_block(tok_text, indent, column_of(text, tok));
            }
            if (i === 0) {
                body = tok_text;
            } else {
                const a = line.tokens[i - 1];
                let gap = line.gaps[i];
                if (options.spacing) {
                    gap = gap_between(a, tok, { gap: line.gaps[i], a_prev: line_prev, a_role: line_prev_role, b_role: role });
                }
                if (gap === '' && would_merge(a, tok, line_prev)) {
                    gap = ' ';
                }
                body += gap + tok_text;
            }
            if (tok.type === 'word' && tok.text === 'switch') {
                saw_switch = true;
            }
            if (tok.type === 'punct' && OPENERS[tok.text] !== undefined) {
                stack.push({ char: tok.text, base: level, is_switch: tok.text === '{' && saw_switch });
                if (tok.text === '{') {
                    saw_switch = false;
                }
            } else if (tok.type === 'punct' && CLOSERS[tok.text] !== undefined) {
                state.ternaries.length = Math.min(state.ternaries.length, stack.length);
                stack.pop();
            }
            if (is_significant(tok)) {
                line_prev = prev_sig;
                prev_sig = tok;
                line_prev_role = role;
                prev_line_end = tok;
                prev_line_end_role = role;
            }
        }
        out.push((indent + body).trimEnd());
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
