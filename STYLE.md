# Moss style: strict, C-style JavaScript

Moss is written as if JavaScript were C. The aim is code you can read top to bottom:
plain functions, plain loops, plain data, nothing clever hiding control flow.
`tests/style.test.js` checks every rule marked **[checked]**, so `npm test` fails
on a violation and points at `file:line`.

## 1. Strict mode, always [checked]

Every file's first statement is `'use strict';`, including ES modules, where it is
redundant but explicit. Strict mode turns silent mistakes into errors: assigning to an
undeclared variable throws instead of creating a global, `this` in a plain call is
`undefined` instead of `window`, and duplicate parameter names are rejected.

**Exception: files Moss injects around user scripts** (`src/shared/runtime/*`,
`src/shared/host/*`). They are joined with the user's code into one script, so a
file-level directive would force strict mode on every userscript, including sloppy
ones imported from elsewhere. Each of these files is one top-level function or IIFE,
and `'use strict';` is the first statement *inside* it:

```js
/* Feature: style — GM_addStyle / GM_addElement. */
(function () {
    'use strict';
    ...
})();
```

**Your own scripts:** add `// @strict` to the header (new scripts get it by default).
Moss then puts `'use strict';` at the top of your script's body. You can also set it
per script in its Options tab, or for every script in Settings → Runtime.

## 2. Names [checked]

- `snake_case` for everything Moss names: variables, functions, parameters, module
  exports, option keys and stored data (`parse_meta`, `wait_for`, `created_at`).
- `UPPER_SNAKE` for constants (`MOSS_VERSION`, `RUNTIME_CORE`).
- Names we don't own keep their spelling: `chrome.tabs.query`, `document.querySelector`,
  `addEventListener`, and the userscript standard (`GM_getValue`, `GM.xmlHttpRequest`).

## 3. Functions

- Named function declarations, each with a C-style comment above it **[checked]**:

  ```js
  /*
   * word_count(text) -> number of words in text
   */
  function word_count(text) {
  ```

- No arrow functions **[checked]**. A short callback may be an anonymous
  `function (...) { }` expression; anything longer becomes a named function.
- Return early instead of nesting. One statement per line.

## 4. Loops [checked]

Write the loop. `for (let i = 0; i < n; i++)` when the index matters, `for (const x of list)`
when it doesn't. No `.map`, `.filter`, `.reduce`, `.forEach`, `.some`, `.every`, `.find`,
`.findIndex` or `.flatMap`: each of those is a loop with the body moved somewhere else.

```js
const names = [];
for (const s of scripts) {
    if (s.enabled) {
        names.push(s.name);
    }
}
```

## 5. Layout [checked]

- Braces on every `if`, `else`, `for` and `while`, even for one line, K&R style
  (`if (x) {` on one line, `} else {`).
- Indent with 4 spaces, never tabs.

## 6. Variables [checked]

- `const` by default, `let` when the value changes, never `var`.
- No `?.`, `??` or `??=`. Check for `null`/`undefined` explicitly, like you would check
  a pointer in C:

  ```js
  if (tab !== null && tab !== undefined) {
      id = tab.id;
  }
  ```

## 7. Data

- Plain objects as structs, built by a `*_create(...)` function, with their shape
  written down where they are defined:

  ```js
  /*
   * struct conn {
   *     key: string;        unique id, "c1", "c2", …
   *     script_id: string;  which script owns this connection
   *     tab_id: number|null; null for background scripts
   * }
   */
  ```

- No classes, no prototypes, no `this` outside DOM event handlers.

## 8. What stays non-C

JavaScript is not C, and Moss does not pretend otherwise where it would hurt:
`async`/`await` for anything that waits, closures where a callback needs state, template
literals for building strings (think `snprintf`), and objects as maps.
