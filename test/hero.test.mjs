import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let metaCalls = [];
let metaHandler = () => null;

globalThis.kino = {
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, String(v)); },
    remove: (k) => { store.delete(k); },
  },
  async meta(req) { metaCalls.push(req); return metaHandler(req); },
};

const { heroSlides } = await import("../src/screen/hero.js");

const BD = (n) => `https://image.tmdb.org/t/p/w1280/b${n}.jpg`;
const LOGO = (n) => `https://image.tmdb.org/t/p/w500/l${n}.png`;

function card(tmdb, kind = "movie") {
  const p = kind === "movie" ? "m" : "s";
  return { id: p + tmdb, ref: `${p}:${tmdb}`, kind, title: "Title " + tmdb, year: 2024, poster: "/p.jpg", ids: { tmdb } };
}

beforeEach(() => {
  store.clear();
  metaCalls = [];
  metaHandler = () => null;
});

test("asks kino.meta by TMDB id and returns a slide with backdrop (and logo)", async () => {
  metaHandler = (r) => ({ backdrop: BD(r.ids.tmdb), logo: LOGO(r.ids.tmdb) });
  const out = await heroSlides([card(10), card(20, "series")]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "m10", ref: "m:10", kind: "movie", title: "Title 10", image: BD(10), logo: LOGO(10) });
  assert.deepEqual(metaCalls[0], { type: "movie", ids: { tmdb: 10 }, title: "Title 10", year: 2024 });
  assert.equal(metaCalls[1].type, "series");
});

test("a title without a backdrop is skipped, filling from deeper in the pool", async () => {
  metaHandler = (r) => (r.ids.tmdb % 2 === 0 ? { backdrop: BD(r.ids.tmdb) } : { logo: LOGO(r.ids.tmdb) }); // odd ids: no backdrop
  const cards = [1, 2, 3, 4, 5, 6].map((n) => card(n));
  const out = await heroSlides(cards);
  assert.deepEqual(out.map((s) => s.id), ["m2", "m4", "m6"]);
  assert.ok(out.every((s) => !("logo" in s)), "no logo kept for these");
});

test("caps at 5 slides even when more have backdrops", async () => {
  metaHandler = (r) => ({ backdrop: BD(r.ids.tmdb) });
  const out = await heroSlides([1, 2, 3, 4, 5, 6, 7, 8].map((n) => card(n)));
  assert.equal(out.length, 5);
});

test("caches: a title asked once is never asked again (even one with no backdrop)", async () => {
  metaHandler = (r) => (r.ids.tmdb === 99 ? null : { backdrop: BD(r.ids.tmdb) });
  await heroSlides([card(99), card(7)]);
  assert.equal(metaCalls.length, 2);
  metaCalls = [];
  const out = await heroSlides([card(99), card(7)]);
  assert.equal(metaCalls.length, 0, "answers come from storage the second time");
  assert.deepEqual(out.map((s) => s.id), ["m7"]);
});

test("rate_limited stops asking but still returns what the cache already had", async () => {
  store.set("movp:hero:v1", JSON.stringify({ m1: { b: BD(1), l: "" } }));
  metaHandler = () => { const e = new Error("slow down"); e.code = "rate_limited"; throw e; };
  const out = await heroSlides([card(1), card(2), card(3)]);
  assert.deepEqual(out.map((s) => s.id), ["m1"]);
});

test("no kino.meta available → no hero, no throw", async () => {
  const saved = globalThis.kino.meta;
  delete globalThis.kino.meta;
  try {
    assert.deepEqual(await heroSlides([card(1), card(2)]), []);
  } finally {
    globalThis.kino.meta = saved;
  }
});

test("ignores cards without a numeric TMDB id", async () => {
  metaHandler = (r) => ({ backdrop: BD(r.ids.tmdb) });
  const out = await heroSlides([{ id: "m5", ref: "m:5", kind: "movie", title: "No ids" }, card(8)]);
  assert.deepEqual(out.map((s) => s.id), ["m8"]);
});
