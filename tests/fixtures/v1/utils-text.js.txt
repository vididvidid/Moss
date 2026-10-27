// utils/text — text helpers any script can share.
// Use it with:  // @use utils/text as text
// Modules see: module, exports, require, api (the calling script's GM functions).

exports.wordCount = function (s) {
  const words = String(s).trim().match(/\S+/g);
  return words ? words.length : 0;
};

exports.readingTime = function (s, wpm) {
  const n = exports.wordCount(s);
  const minutes = Math.max(1, Math.round(n / (wpm || 230)));
  return `${n.toLocaleString()} words · about ${minutes} min read`;
};
