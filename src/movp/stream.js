// Stream the elements of a big top-level JSON array out of raw text, WITHOUT JSON.parse'ing the whole thing.
// Why: QuickJS's JSON.parse recurses once per array element, so a ~25k-item catalog overflows the native plugin stack
// (a SIGSEGV that kills the whole app — measured on a Redmi Note 9 Pro). Here we find each array and hand back its
// elements as small JSON snippets, parsed one small batch at a time, so the parser never recurses deep.
//
// Scope: the light Movie+ catalog is `{ "v":2, .., "items":[ [..], [..], .. ] }` — a root object whose `items` is an
// array of small rows. The scanner tracks strings, escapes and nested {}/[], so rows with their own arrays or objects
// are handled; it does not need a full JSON grammar.

/**
 * The offset just inside the array value of the top-level key `key` (one past its `[`), or -1 when absent.
 * Matches `"key"` only where it is used as a key (followed, past spaces, by `:`), so a value that happens to equal the
 * key's text is never mistaken for it.
 */
export function arrayStart(text, key) {
  const needle = '"' + key + '"';
  let k = text.indexOf(needle);
  while (k >= 0) {
    let j = k + needle.length;
    while (j < text.length && text.charCodeAt(j) <= 32) j++;
    if (text[j] === ":") {
      const b = text.indexOf("[", j);
      return b < 0 ? -1 : b + 1;
    }
    k = text.indexOf(needle, k + needle.length);
  }
  return -1;
}

/**
 * Up to `max` element substrings of an array, from `offset` (just inside the `[`, or just past a top-level comma).
 * @returns {{elems:string[], next:number, done:boolean}} `elems` trimmed raw element texts, `next` where to resume,
 *   `done` true once the array's matching `]` was reached.
 */
export function scanElements(text, offset, max) {
  const elems = [];
  const n = text.length;
  let i = offset, depth = 0, inStr = false, esc = false, start = -1;
  for (; i < n; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (start < 0) start = i; inStr = true; continue; }
    if (ch === "{" || ch === "[") { if (start < 0) start = i; depth++; continue; }
    if (ch === "}") { if (depth > 0) depth--; continue; }
    if (ch === "]") {
      if (depth === 0) {
        if (start >= 0) elems.push(text.slice(start, i).trim());
        return { elems, next: i + 1, done: true };
      }
      depth--;
      continue;
    }
    if (depth === 0 && ch === ",") {
      if (start >= 0) { elems.push(text.slice(start, i).trim()); start = -1; }
      if (elems.length >= max) return { elems, next: i + 1, done: false };
      continue;
    }
    if (start < 0 && text.charCodeAt(i) > 32) start = i;
  }
  if (start >= 0) elems.push(text.slice(start, i).trim());
  return { elems, next: i, done: true };
}

/** The number of elements in the array named `key` — a cheap scan, no JSON.parse. */
export function countArray(text, key) {
  const start = arrayStart(text, key);
  if (start < 0) return 0;
  const n = text.length;
  let i = start, depth = 0, inStr = false, esc = false, count = 0, seen = false;
  for (; i < n; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { seen = true; inStr = true; continue; }
    if (ch === "{" || ch === "[") { seen = true; depth++; continue; }
    if (ch === "}") { if (depth > 0) depth--; continue; }
    if (ch === "]") { if (depth === 0) return seen ? count + 1 : count; depth--; continue; }
    if (depth === 0 && ch === ",") { count++; seen = false; continue; }
    if (!seen && text.charCodeAt(i) > 32) seen = true;
  }
  return seen ? count + 1 : count;
}
