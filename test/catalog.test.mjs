import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const sampleGz = readFileSync(new URL("./fixtures/items-sample.json.gz", import.meta.url));
const sample = JSON.parse(gunzipSync(sampleGz).toString("utf8"));
const SAMPLE_TOTAL = sample.movies.length + sample.series.length;

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
  CATEGORIES, typeToCategory, fetchCatalog, toCatalogItems, importCatalog, recentByCategory, catalogCount, isCatalogReady, browseCategory,
} = await import("../src/movp/catalog.js");

const URLS = [
  "https://raw.githubusercontent.com/dev-mplus01/mplus01T/main/db/items.json.gz",
  "https://appsdevxp.com/app/db/items.json.gz",
  "https://developerxploit.com/app/db/items.json.gz",
];

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

test("fetchCatalog downloads and parses the gzip catalog", async () => {
  const cat = await fetchCatalog();
  assert.equal(cat.movies.length, sample.movies.length);
  assert.equal(cat.series.length, sample.series.length);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, URLS[0]);
});

test("fetchCatalog falls back through the mirrors in order", async () => {
  fetchHandler = (url) => (url === URLS[2] ? { status: 200, bytes: sampleGz } : { status: 503, bytes: Buffer.from("down") });
  const cat = await fetchCatalog();
  assert.equal(cat.series.length, sample.series.length);
  assert.deepEqual(fetchCalls.map((c) => c.url), URLS);
});

test("fetchCatalog falls through a mirror that throws or serves garbage", async () => {
  fetchHandler = (url) => {
    if (url === URLS[0]) throw new KinoError("network", "boom");
    if (url === URLS[1]) return { status: 200, bytes: Buffer.from("not gzip at all, just text") };
    return { status: 200, bytes: sampleGz };
  };
  const cat = await fetchCatalog();
  assert.equal(cat.movies.length, sample.movies.length);
  assert.equal(fetchCalls.length, 3);
});

test("fetchCatalog fails clearly when every mirror fails", async () => {
  fetchHandler = () => ({ status: 500, bytes: Buffer.from("x") });
  await assert.rejects(fetchCatalog(), (e) => e.code === "unavailable");
  assert.equal(fetchCalls.length, 3);
});

test("fetchCatalog inflates a catalog over kino.crypto.gunzip's 5 MB cap in pure JS", async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const word = () => rnd().toString(36);
  const big = { movies: [], series: [] };
  for (let i = 0; i < 35000; i++) {
    big.movies.push({
      id: 100000 + i, type: 1, nameFile: `Película ñandú ${word()} ${word()}`, date: "2021-10-12",
      generos: "Drama , Acción", urlImage: `/${word()}${word()}${word()}.jpg`, vote: i % 10,
      urls: [`720p CAST,_,1.52 GB,_,${word()}${word()}${word()}${word()}${word()}${word()}${word()}`],
    });
  }
  for (let i = 0; i < 2000; i++) big.series.push({ id: 900000 + i, type: 2 + (i % 5), nameFile: `Serie ${word()}`, date: "2022-03-24" });
  const raw = Buffer.from(JSON.stringify(big), "utf8");
  assert.ok(raw.length > 5242880, "fixture must exceed the native cap");
  const gz = gzipSync(raw);
  fetchHandler = () => ({ status: 200, bytes: gz });
  const cat = await fetchCatalog();
  assert.equal(cat.movies.length, 35000);
  assert.equal(cat.series.length, 2000);
  assert.deepEqual(cat.movies[34999], big.movies[34999]);
  assert.equal(cat.movies[7].nameFile, big.movies[7].nameFile);
});

test("toCatalogItems maps movies and series", () => {
  const items = toCatalogItems(sample);
  assert.equal(items.length, SAMPLE_TOTAL);
  const halo = items.find((i) => i.id === "s:52814");
  assert.deepEqual(halo, {
    id: "s:52814", kind: "series", type: 2, title: "Halo", year: "2022",
    poster: "/lfTm372lHNjQnnUwpdumVfUB0rh.jpg", genres: ["fantasia ciencia ficción"], categoryKey: "series",
  });
  const movie = items.find((i) => i.id === "m:800410");
  assert.equal(movie.kind, "movie");
  assert.equal(movie.type, 1);
  assert.equal(movie.categoryKey, "peliculas");
  assert.equal(movie.year, "2021");
  assert.deepEqual(movie.genres, ["Drama", "Terror", "Suspense"]);
  const anime = items.find((i) => i.kind === "series" && i.type === 4);
  assert.equal(anime.categoryKey, "animes");
  assert.equal(new Set(items.map((i) => i.id)).size, SAMPLE_TOTAL);
});

test("toCatalogItems defaults a missing type and tolerates missing fields", () => {
  const items = toCatalogItems({
    movies: [{ id: 1, nameFile: "A", date: "1999-01-02" }],
    series: [{ id: 2, nameFile: "B" }],
  });
  assert.equal(items[0].type, 1);
  assert.equal(items[0].id, "m:1");
  assert.equal(items[1].type, 2);
  assert.equal(items[1].id, "s:2");
  assert.equal(items[1].year, "");
  assert.equal(items[1].poster, "");
  assert.deepEqual(items[1].genres, []);
  assert.deepEqual(toCatalogItems({}), []);
});

test("importCatalog indexes the sample into kino.catalog in one go", async () => {
  const r = await importCatalog(await fetchCatalog());
  assert.deepEqual(r, { done: true, cursor: SAMPLE_TOTAL, total: SAMPLE_TOTAL });
  assert.equal(await kino.catalog.count(), SAMPLE_TOTAL);
  assert.equal(await catalogCount(), SAMPLE_TOTAL);
  const [halo] = await kino.catalog.get(["s:52814"]);
  assert.equal(halo.title, "Halo");
  assert.equal(halo.data.k, "series");
  assert.equal(halo.data.t, 2);
  assert.equal(halo.data.y, "2022");
  assert.equal(halo.data.p, "/lfTm372lHNjQnnUwpdumVfUB0rh.jpg");
  assert.equal(halo.sort, Date.parse("2022-03-24"));
  assert.ok(store.size > 0);
});

test("importCatalog is resumable by batches and the cursor survives between calls", async () => {
  const cat = await fetchCatalog();
  const a = await importCatalog(cat, { batch: 10 });
  assert.deepEqual(a, { done: false, cursor: 10, total: SAMPLE_TOTAL });
  assert.equal(await kino.catalog.count(), 10);
  const b = await importCatalog(cat, { batch: 10 });
  assert.deepEqual(b, { done: false, cursor: 20, total: SAMPLE_TOTAL });
  const c = await importCatalog(cat, { batch: 10 });
  assert.deepEqual(c, { done: true, cursor: SAMPLE_TOTAL, total: SAMPLE_TOTAL });
  assert.equal(await kino.catalog.count(), SAMPLE_TOTAL);
  const [halo] = await kino.catalog.get(["s:52814"]);
  assert.equal(halo.title, "Halo");
});

test("importCatalog resumes from storage with a freshly downloaded catalog", async () => {
  await importCatalog(await fetchCatalog(), { batch: 7 });
  const again = await importCatalog(await fetchCatalog(), { batch: 7 });
  assert.equal(again.cursor, 14);
  assert.equal(again.done, false);
});

test("importCatalog restarts when the catalog changed under the cursor", async () => {
  const cat = await fetchCatalog();
  await importCatalog(cat, { batch: 10 });
  const other = { movies: cat.movies.slice(0, 2), series: cat.series.slice(0, 3) };
  const r = await importCatalog(other, { batch: 4 });
  assert.deepEqual(r, { done: false, cursor: 4, total: 5 });
});

test("importCatalog clears its cursor when done so the next import starts over", async () => {
  const cat = await fetchCatalog();
  await importCatalog(cat);
  const r = await importCatalog(cat, { batch: 10 });
  assert.deepEqual(r, { done: false, cursor: 10, total: SAMPLE_TOTAL });
});

test("importCatalog honours an explicit cursor and clamps the batch to kino.catalog's 500 cap", async () => {
  const cat = await fetchCatalog();
  const r = await importCatalog(cat, { batch: 10, cursor: 25 });
  assert.deepEqual(r, { done: true, cursor: SAMPLE_TOTAL, total: SAMPLE_TOTAL });
  assert.equal(await kino.catalog.count(), 5);
  const huge = { movies: Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, nameFile: "T" + i, date: "2020-01-01" })), series: [] };
  const big = await importCatalog(huge, { batch: 100000 });
  assert.deepEqual(big, { done: false, cursor: 500, total: 1200 });
});

test("recentByCategory lists the newest items of one category", async () => {
  await importCatalog(await fetchCatalog());
  const animes = await recentByCategory("animes", 100);
  const expected = toCatalogItems(sample).filter((i) => i.categoryKey === "animes");
  assert.equal(animes.length, expected.length);
  assert.ok(animes.every((i) => i.categoryKey === "animes" && (i.type === 3 || i.type === 4)));
  assert.deepEqual(animes.map((i) => i.id).sort(), expected.map((i) => i.id).sort());
  const dates = animes.map((i) => rows.get(i.id).sort);
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  const limited = await recentByCategory("animes", 3);
  assert.equal(limited.length, 3);
  assert.deepEqual(limited[0], animes[0]);
  const halo = (await recentByCategory("series", 100)).find((i) => i.id === "s:52814");
  assert.deepEqual(halo, toCatalogItems(sample).find((i) => i.id === "s:52814"));
  assert.deepEqual(await recentByCategory("duanju", 10), []);
});

test("recentByCategory still works from kino.catalog when the recent lists are gone", async () => {
  await importCatalog(await fetchCatalog());
  for (const k of store.keys()) store.delete(k);
  const peliculas = await recentByCategory("peliculas", 100);
  assert.equal(peliculas.length, sample.movies.length);
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
  const cat = await fetchCatalog();
  await importCatalog(cat, { batch: 10 });
  assert.ok((await catalogCount()) > 0);
  assert.equal(await isCatalogReady(), false);
  await importCatalog(cat, { batch: 10 });
  assert.equal(await isCatalogReady(), false);
  const last = await importCatalog(cat, { batch: 10 });
  assert.equal(last.done, true);
  assert.equal(await isCatalogReady(), true);
  await importCatalog(cat, { batch: 10 });
  assert.equal(await isCatalogReady(), false, "a new partial re-import is not ready");
});

test("isCatalogReady is false when the done-marker exists but kino.catalog is empty", async () => {
  const cat = await fetchCatalog();
  await importCatalog(cat);
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
