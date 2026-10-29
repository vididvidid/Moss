'use strict';
/*
 * Syntax colouring for the dashboard: turns code into HTML spans (classes "t-…",
 * styled in dashboard.css). Header lines of both formats get their keys coloured:
 * "// @match …" in a userscript header and "// match: …" in a .moss header.
 */
import { KEYWORDS, LITERALS, is_significant, tokenize } from '../lib/js_tokens.js';

// Names a userscript gets from Moss: coloured so they stand out from plain variables.
const API_RE = /^(?:GM_\w+|GM|unsafeWindow|moss|require)$/;
const HEADER_START = /^\/\/\s*==(?:UserScript|Moss)==/;
const HEADER_END = /^\/\/\s*==\/(?:UserScript|Moss)==/;
export const MAX_HIGHLIGHT = 400000;   // characters; bigger files are shown plain

/*
 * escape_html(text) -> text safe to put inside an element
 */
export function escape_html(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/*
 * span(cls, text) -> '<span class="cls">text</span>' with text escaped
 */
function span(cls, text) {
    return `<span class="${cls}">${escape_html(text)}</span>`;
}

/*
 * header_comment(text) -> HTML for one comment line inside a script header
 */
function header_comment(text) {
    if (HEADER_START.test(text) || HEADER_END.test(text)) {
        return span('t-meta-mark', text);
    }
    const m = /^(\/\/\s*)(@[\w:.-]+|[A-Za-z][\w.-]*(?::[A-Za-z-]+)?:|\s+-)(.*)$/.exec(text);
    if (m === null) {
        return span('t-com', text);
    }
    return span('t-com', m[1]) + span('t-meta-key', m[2]) + span('t-meta-val', m[3]);
}

/*
 * word_class(tokens, i, prev) -> the class for the word token at i, or ''
 */
function word_class(tokens, i, prev) {
    const text = tokens[i].text;
    if (prev !== null && prev.type === 'punct' && (prev.text === '.' || prev.text === '?.')) {
        return 't-prop';
    }
    if (KEYWORDS.indexOf(text) >= 0) {
        return 't-kw';
    }
    if (LITERALS.indexOf(text) >= 0) {
        return 't-lit';
    }
    if (API_RE.test(text)) {
        return 't-api';
    }
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === 'space') {
        j++;
    }
    if (j < tokens.length && tokens[j].type === 'punct' && tokens[j].text === '(') {
        return 't-fn';
    }
    return '';
}

/*
 * highlight(code) -> HTML with coloured spans; the text content equals code
 */
export function highlight(code) {
    if (code.length > MAX_HIGHLIGHT) {
        return escape_html(code);
    }
    const tokens = tokenize(code);
    let out = '';
    let prev = null;
    let in_header = false;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        switch (tok.type) {
        case 'comment':
            if (HEADER_START.test(tok.text)) {
                in_header = true;
            }
            out += in_header ? header_comment(tok.text) : span('t-com', tok.text);
            if (HEADER_END.test(tok.text)) {
                in_header = false;
            }
            break;
        case 'block':
            out += span('t-com', tok.text);
            break;
        case 'string':
        case 'template':
            out += span('t-str', tok.text);
            break;
        case 'regex':
            out += span('t-re', tok.text);
            break;
        case 'number':
            out += span('t-num', tok.text);
            break;
        case 'word': {
            const cls = word_class(tokens, i, prev);
            out += cls === '' ? escape_html(tok.text) : span(cls, tok.text);
            break;
        }
        case 'punct':
            out += /^[{}()[\]]$/.test(tok.text) ? span('t-br', tok.text) : escape_html(tok.text);
            break;
        default:
            out += escape_html(tok.text);
        }
        if (is_significant(tok)) {
            prev = tok;
        }
    }
    return out;
}
