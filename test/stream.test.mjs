import { test } from "node:test";
import assert from "node:assert/strict";
import { arrayStart, scanElements, countArray } from "../src/movp/stream.js";

/** Collect every element of the array `key` by scanning in batches of `batch`. */
function allElements(text, key, batch) {
  const out = [];
  let off = arrayStart(text, key);
  assert.ok(off >= 0, `array ${key} found`);
  for (;;) {
    const { elems, next, done } = scanElements(text, off, batch);
    out.push(...elems);
    off = next;
    if (done) break;
  }
  return out;
}

const CAT = JSON.stringify({
  series: [{ id: 1, nameFile: "A", urls: ["x", "y"] }, { id: 2, nameFile: "B]," /* tricky string */ }],
  movies: [{ id: 10, nameFile: "C", generos: "Drama , Terror", nested: { a: [1, 2, { b: "}" }] } }, { id: 11 }, { id: 12, nameFile: "quote \" and \\ end" }],
  recomends: [],
  recentsNodes: [{ id: 99 }],
});

test("arrayStart finds top-level arrays and -1 for absent", () => {
  assert.ok(arrayStart(CAT, "movies") > 0);
  assert.ok(arrayStart(CAT, "series") > 0);
  assert.equal(arrayStart(CAT, "nope"), -1);
  // not fooled by the word appearing inside a value
  assert.equal(arrayStart('{"x":"movies","movies":[1]}', "movies"), '{"x":"movies","movies":['.length);
});

test("countArray counts elements without parsing", () => {
  assert.equal(countArray(CAT, "movies"), 3);
  assert.equal(countArray(CAT, "series"), 2);
  assert.equal(countArray(CAT, "recomends"), 0);
  assert.equal(countArray(CAT, "recentsNodes"), 1);
});

test("scanElements yields valid JSON for every element, across batch sizes", () => {
  const real = JSON.parse(CAT);
  for (const batch of [1, 2, 3, 100]) {
    const movies = allElements(CAT, "movies", batch).map((e) => JSON.parse(e));
    assert.deepEqual(movies, real.movies, `movies batch=${batch}`);
    const series = allElements(CAT, "series", batch).map((e) => JSON.parse(e));
    assert.deepEqual(series, real.series, `series batch=${batch}`);
  }
});

test("handles strings with braces, brackets, quotes and escapes inside elements", () => {
  const movies = allElements(CAT, "movies", 2).map((e) => JSON.parse(e));
  assert.equal(movies[0].nested.a[2].b, "}");
  assert.equal(movies[2].nameFile, 'quote " and \\ end');
  const series = allElements(CAT, "series", 1).map((e) => JSON.parse(e));
  assert.equal(series[1].nameFile, "B],");
});

test("empty array yields nothing and is done at once", () => {
  const off = arrayStart(CAT, "recomends");
  const { elems, done } = scanElements(CAT, off, 10);
  assert.deepEqual(elems, []);
  assert.equal(done, true);
});

test("a big flat array round-trips element by element", () => {
  const big = { movies: Array.from({ length: 5000 }, (_, i) => ({ id: i, n: "x" + i })) };
  const text = JSON.stringify(big);
  assert.equal(countArray(text, "movies"), 5000);
  const got = allElements(text, "movies", 250).map((e) => JSON.parse(e));
  assert.equal(got.length, 5000);
  assert.deepEqual(got[0], { id: 0, n: "x0" });
  assert.deepEqual(got[4999], { id: 4999, n: "x4999" });
});
