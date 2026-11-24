import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const sampleGz = readFileSync(new URL("./fixtures/items-sample.json.gz", import.meta.url));
const sample = JSON.parse(gunzipSync(sampleGz).toString("utf8"));
const SAMPLE_TOTAL = sample.items.length;
const SAMPLE_MOVIES = sample.items.filter((r) => r[1] === 1).length;

const store = new Map();
const rows = new Map();
let fetchCalls = [];
let fetchHandler = () => ({ status: 200, bytes: sampleGz });

class KinoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const norm = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

globalThis.kino = {
  crypto: {
    gunzip(data) {
      try {
        return gunzipSync(Buffer.from(data, "base64"), { maxOutputLength: 5242880 }).toString("utf8");
      } catch (e) {
        throw new KinoError("crypto_error", e.code === "ERR_BUFFER_TOO_LARGE" ? "the unzipped data is over 5 MB" : "invalid crypto operation");
      }
    },
  },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  catalog: {
    async upsert(items) {
      assert.ok(items.length <= 500, "upsert over 500 items");
      for (const it of items) {
        assert.ok(it.id.length >= 1 && it.id.length <= 128);
        assert.ok(it.title.length <= 300);
        assert.ok(Number.isSafeInteger(it.sort ?? 0));
        assert.ok(JSON.stringify(it.data ?? null).length <= 4096);
        rows.set(it.id, { id: it.id, title: it.title, sort: it.sort ?? 0, data: it.data ?? null });
      }
      return { count: items.length };
    },
    async get(ids) { return ids.filter((i) => rows.has(i)).map((i) => structuredClone(rows.get(i))); },
    async count() { return rows.size; },
    async clear() { rows.clear(); },
    async remove(ids) { let c = 0; for (const i of ids) if (rows.delete(i)) c++; return { count: c }; },
    async search({ q = "", limit = 50, offset = 0 } = {}) {
      const words = norm(q).split(/\s+/).filter(Boolean);
      const hits = [...rows.values()]
        .filter((r) => words.every((w) => norm(r.title).includes(w)))
        .sort((a, b) => b.sort - a.sort || (a.id < b.id ? -1 : 1));
      return { items: hits.slice(offset, offset + limit).map((r) => structuredClone(r)), total: hits.length };
    },
  },
  error: (code, message) => new KinoError(code, message),
  async fetch(url, opts = {}) {
    fetchCalls.push({ url, opts });
    const { status = 200, bytes } = await fetchHandler(url);
    return {
      ok: status >= 200 && status < 300, status, url, headers: {},
      base64: () => Buffer.from(bytes || []).toString("base64"),
      text: () => Buffer.from(bytes || []).toString("utf8"),
      json: () => JSON.parse(Buffer.from(bytes || []).toString("utf8")),
    };
  },
};

const {
  CATEGORIES, CATALOG_URLS, typeToCategory, fetchCatalogText, countItemsText, toItem, importTextTick, finishImport,
  recentByCategory, catalogCount, isCatalogReady, browseCategory,
} = await import("../src/movp/catalog.js");
const { importAll } = await import("./light.mjs");

const URL_LIGHT = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-movieplus/data/items-light.json.gz";
const sampleText = () => gunzipSync(sampleGz).toString("utf8");

beforeEach(() => {
  store.clear();
  rows.clear();
  fetchCalls = [];
  fetchHandler = () => ({ status: 200, bytes: sampleGz });
});

test("categories keep the tab-bar order and the type mapping", () => {
  assert.deepEqual(CATEGORIES.map((c) => c.key), ["peliculas", "series", "animes", "doramas", "duanju", "telenovelas"]);
  assert.equal(CATEGORIES[0].key, "peliculas");
  assert.deepEqual(Object.fromEntries(CATEGORIES.map((c) => [c.key, c.types])), {
    peliculas: [1], series: [2], animes: [3, 4], doramas: [6], duanju: [7], telenovelas: [5],
  });
  for (const c of CATEGORIES) assert.ok(c.label && c.labelEn, c.key);
  assert.equal(CATEGORIES[2].label, "Animes-Cartoons");
});

test("typeToCategory maps every catalog type", () => {
  assert.equal(typeToCategory(1), "peliculas");
  assert.equal(typeToCategory(2), "series");
  assert.equal(typeToCategory(3), "animes");
  assert.equal(typeToCategory(4), "animes");
  assert.equal(typeToCategory(5), "telenovelas");
  assert.equal(typeToCategory(6), "doramas");
  assert.equal(typeToCategory(7), "duanju");
  assert.equal(typeToCategory("4"), "animes");
});

test("the catalog comes only from the light file on the plugin's data branch", () => {
  assert.deepEqual(CATALOG_URLS, [URL_LIGHT]);
});

test("fetchCatalogText downloads and unzips the light catalog", async () => {
  const text = await fetchCatalogText();
  assert.equal(text, sampleText());
  assert.equal(countItemsText(text), SAMPLE_TOTAL);
  assert.deepEqual(fetchCalls.map((c) => c.url), [URL_LIGHT]);
});

test("fetchCatalogText fails clearly on an HTTP error, a throw, garbage or the old full-catalog shape", async () => {
  const old = gzipSync(JSON.stringify({ movies: [{ id: 1, nameFile: "A" }], series: [] }));
  for (const handler of [
    () => ({ status: 500, bytes: Buffer.from("x") }),
    () => { throw new KinoError("network", "boom"); },
    () => ({ status: 200, bytes: Buffer.from("not gzip at all, just text") }),
    () => ({ status: 200, bytes: old }),
  ]) {
    fetchHandler = handler;
    await assert.rejects(fetchCatalogText(), (e) => e.code === "unavailable");
  }
});

test("fetchCatalogText inflates a catalog over kino.crypto.gunzip's 5 MB cap in pure JS", async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const word = () => rnd().toString(36);
  const items = [];
  for (let i = 0; i < 60000; i++) {
    items.push([100000 + i, 1 + (i % 7), "2021-10-12", `Película ñandú ${word()} ${word()}`, `/${word()}${word()}${word()}.jpg`, "Drama , Acción"]);
  }
  const raw = Buffer.from(JSON.stringify({ v: 2, items }), "utf8");
  assert.ok(raw.length > 5242880, "fixture must exceed the native cap");
  fetchHandler = () => ({ status: 200, bytes: gzipSync(raw) });
  const text = await fetchCatalogText();
  assert.equal(text, raw.toString("utf8"));
  assert.equal(countItemsText(text), 60000);
});

test("toItem maps a light row to a catalog item", () => {
  assert.deepEqual(toItem([52814, 2, "2022-03-24", "Halo", "/lfTm372lHNjQnnUwpdumVfUB0rh.jpg", "fantasia ciencia ficción"]), {
    id: "s:52814", kind: "series", type: 2, title: "Halo", year: "2022",
    poster: "/lfTm372lHNjQnnUwpdumVfUB0rh.jpg", genres: ["fantasia ciencia ficción"], categoryKey: "series",
  });
  const movie = toItem([800410, 1, "2021-10-12", "El paramo", "/p.jpg", "Drama , Terror , Suspense"]);
  assert.equal(movie.id, "m:800410");
  assert.equal(movie.kind, "movie");
  assert.equal(movie.categoryKey, "peliculas");
  assert.deepEqual(movie.genres, ["Drama", "Terror", "Suspense"]);
  assert.equal(toItem([7, 4, "", "Cartoon"]).categoryKey, "animes");
  assert.equal(toItem([7, 4, "", "Cartoon"]).kind, "series");
});

test("toItem tolerates missing fields and refuses rows without a TMDB id", () => {
  assert.deepEqual(toItem([2]), { id: "m:2", kind: "movie", type: 1, title: "", year: "", poster: "", genres: [], categoryKey: "peliculas" });
  for (const bad of [null, {}, [], [0, 1], [-3, 1], ["abc", 1], [1.5, 1]]) assert.equal(toItem(bad), null, JSON.stringify(bad));
});

test("importTextTick imports the sample batch by batch from a serializable cursor", async () => {
  const text = sampleText();
  const a = await importTextTick(text, null, 10);
  assert.equal(a.done, 10);
  assert.equal(a.finished, false);
  assert.equal(await kino.catalog.count(), 10);
  const cursor = JSON.parse(JSON.stringify(a));
  const b = await importTextTick(text, cursor, 10);
  assert.equal(b.done, 20);
  const c = await importTextTick(text, b, 10);
  assert.equal(c.finished, true);
  assert.equal(c.done, SAMPLE_TOTAL);
  assert.equal(await kino.catalog.count(), SAMPLE_TOTAL);
  const [halo] = await kino.catalog.get(["s:52814"]);
  assert.equal(halo.title, "Halo");
  assert.deepEqual(halo.data, { k: "series", t: 2, y: "2022", p: "/lfTm372lHNjQnnUwpdumVfUB0rh.jpg", g: "fantasia ciencia ficción" });
  assert.equal(halo.sort, Date.parse("2022-03-24"));
});

test("importTextTick clamps the batch to kino.catalog's 500 cap", async () => {
  const items = Array.from({ length: 1200 }, (_, i) => [i + 1, 1, "2020-01-01", "T" + i]);
  const r = await importTextTick(JSON.stringify({ v: 2, items }), null, 100000);
  assert.equal(r.done, 500);
  assert.equal(r.finished, false);
});

test("importTextTick skips rows it cannot use and still finishes", async () => {
  const text = JSON.stringify({ v: 2, items: [[1, 1, "2020-01-01", "A"], [0, 1, "", "no id"], { id: 3 }, [4, 6, "2021-01-01", "D"]] });
  const r = await importTextTick(text, null, 500);
  assert.equal(r.finished, true);
  assert.deepEqual([...rows.keys()].sort(), ["m:1", "s:4"]);
});

test("importTextTick refuses a text that is not the light catalog", async () => {
  await assert.rejects(importTextTick(JSON.stringify({ movies: [{ id: 1 }] }), null, 10), (e) => e.code === "unavailable");
  assert.equal(rows.size, 0);
});

test("recentByCategory lists the newest items of one category", async () => {
  await importAll(sampleText());
  const animes = await recentByCategory("animes", 100);
  const expected = sample.items.map(toItem).filter((i) => i.categoryKey === "animes");
  assert.equal(animes.length, expected.length);
  assert.ok(animes.every((i) => i.categoryKey === "animes" && (i.type === 3 || i.type === 4)));
  assert.deepEqual(animes.map((i) => i.id).sort(), expected.map((i) => i.id).sort());
  const dates = animes.map((i) => rows.get(i.id).sort);
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  const limited = await recentByCategory("animes", 3);
  assert.equal(limited.length, 3);
  assert.deepEqual(limited[0], animes[0]);
  const halo = (await recentByCategory("series", 100)).find((i) => i.id === "s:52814");
  assert.deepEqual(halo, toItem(sample.items.find((r) => r[0] === 52814)));
  assert.deepEqual(await recentByCategory("duanju", 10), []);
});

test("recentByCategory still works from kino.catalog when the recent lists are gone", async () => {
  await importAll(sampleText());
  for (const k of store.keys()) store.delete(k);
  const peliculas = await recentByCategory("peliculas", 100);
  assert.equal(peliculas.length, SAMPLE_MOVIES);
  assert.ok(peliculas.every((i) => i.kind === "movie"));
});

test("catalogCount is 0 for an empty catalog", async () => {
  assert.equal(await catalogCount(), 0);
});

test("inflate handles stored, fixed and dynamic deflate blocks and rejects garbage", async () => {
  const { gunzipBytes } = await import("../src/movp/inflate.js");
  const text = Buffer.from("hola ".repeat(5000) + "ñandú ".repeat(3000), "utf8");
  for (const opts of [{ level: 0 }, { level: 9, strategy: 4 }, { level: 6 }]) {
    assert.deepEqual(Buffer.from(gunzipBytes(new Uint8Array(gzipSync(text, opts)))), text);
  }
  assert.deepEqual(Buffer.from(gunzipBytes(new Uint8Array(gzipSync(Buffer.alloc(0))))), Buffer.alloc(0));
  assert.throws(() => gunzipBytes(new Uint8Array(40)), /not a gzip/);
  const gz = new Uint8Array(gzipSync(text));
  assert.throws(() => gunzipBytes(gz.slice(0, gz.length >> 1)));
});

test("isCatalogReady is true only after a full import completes", async () => {
  assert.equal(await isCatalogReady(), false);
  const text = sampleText();
  const first = await importTextTick(text, null, 10);
  assert.ok((await catalogCount()) > 0);
  assert.equal(await isCatalogReady(), false);
  let cur = first;
  while (!cur.finished) cur = await importTextTick(text, cur, 10);
  assert.equal(await isCatalogReady(), false, "not ready before finishImport");
  finishImport(cur.recent, cur.done);
  assert.equal(await isCatalogReady(), true);
});

test("isCatalogReady is false when the done-marker exists but kino.catalog is empty", async () => {
  await importAll(sampleText());
  assert.equal(await isCatalogReady(), true);
  await kino.catalog.clear();
  assert.equal(await isCatalogReady(), false);
});

const seedRows = (n, type, sortStart, prefix) => {
  for (let i = 0; i < n; i++) rows.set(`${prefix}:${i}`, { id: `${prefix}:${i}`, title: `${prefix} ${i}`, sort: sortStart - i, data: { k: type === 1 ? "movie" : "series", t: type } });
};

test("browseCategory stops paging when a full scan window finds nothing in a sparse category", async () => {
  seedRows(1200, 1, 100000, "m");
  seedRows(5, 6, 1, "d");
  const page = await browseCategory("doramas", { offset: 0, limit: 20 });
  assert.deepEqual(page.items, []);
  assert.equal(page.next, null);
});

test("browseCategory still returns a cursor when the window found some items and more may exist", async () => {
  seedRows(1200, 1, 100000, "m");
  seedRows(5, 6, 99500, "d");
  const page = await browseCategory("doramas", { offset: 0, limit: 20 });
  assert.equal(page.items.length, 5);
  assert.equal(page.next, 1000);
  const full = await browseCategory("peliculas", { offset: 0, limit: 20 });
  assert.equal(full.items.length, 20);
  assert.ok(full.next > 0);
});
