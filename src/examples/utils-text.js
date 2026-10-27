'use strict';
/*
 * utils/text — text helpers any script can share.
 * Use it with:  // @use utils/text as text
 * Modules see: module, exports, require, api (the calling script's GM functions).
 */

/*
 * word_count(s) -> number of words in s
 */
function word_count(s) {
    let count = 0;
    let in_word = false;
    const text = String(s);
    for (let i = 0; i < text.length; i++) {
        const is_space = /\s/.test(text[i]);
        if (is_space) {
            in_word = false;
        } else if (!in_word) {
            in_word = true;
            count++;
        }
    }
    return count;
}

/*
 * reading_time(s, wpm) -> "1,234 words · about 6 min read"
 */
function reading_time(s, wpm) {
    const n = word_count(s);
    const minutes = Math.max(1, Math.round(n / (wpm || 230)));
    return `${n.toLocaleString()} words · about ${minutes} min read`;
}

exports.word_count = word_count;
exports.reading_time = reading_time;
