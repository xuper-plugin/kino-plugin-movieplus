import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const vectors = fixture("rsa-vectors");
const movieVariants = fixture("movie-variants");
const documentTv = fixture("document-tv");
const playback = fixture("playback");

const store = new Map();
const rows = new Map();
let fetchCalls = [];
let fetchHandler = () => { throw new Error("no fetch handler"); };
let tmdbCalls = [];
let tmdbHandler = () => { throw new Error("no tmdb handler"); };
let config = {};

class KinoError extends Error {
  constructor(code, message, opts) {
    super(message);
    this.code = code;
    if (opts && opts.userMessage) this.userMessage = opts.userMessage;
  }
}

const norm = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

globalThis.kino = {
  lang: "es",
  crypto: {
    hash(alg, data, opts = {}) {
      const input = opts.inputEncoding === "hex" ? Buffer.from(data, "hex") : Buffer.from(data, "utf8");
      return createHash(alg).update(input).digest(opts.outputEncoding || "hex");
    },
    modPow(baseHex, expHex, modHex) {
      let base = BigInt("0x" + baseHex), exp = BigInt("0x" + expHex);
      const mod = BigInt("0x" + modHex);
      let r = 1n;
      base %= mod;
      while (exp > 0n) {
        if (exp & 1n) r = (r * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
      }
      return r.toString(16).padStart(Math.ceil(modHex.length / 2) * 2, "0");
    },
    randomBytes: (n, enc = "hex") => randomBytes(n).toString(enc),
    uuid: () => randomUUID(),
  },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  config: { get: (k) => config[k], all: () => ({ ...config }) },
  catalog: {
    async upsert(items) {
      for (const it of items) rows.set(it.id, { id: it.id, title: it.title, sort: it.sort ?? 0, data: it.data ?? null });
      return { count: items.length };
    },
    async get(ids) { return ids.filter((i) => rows.has(i)).map((i) => structuredClone(rows.get(i))); },
    async count() { return rows.size; },
    async search({ q = "", limit = 50, offset = 0 } = {}) {
      const words = norm(q).split(/\s+/).filter(Boolean);
      const hits = [...rows.values()]
        .filter((r) => words.every((w) => norm(r.title).includes(w)))
        .sort((a, b) => b.sort - a.sort || (a.id < b.id ? -1 : 1));
      return { items: hits.slice(offset, offset + limit).map((r) => structuredClone(r)), total: hits.length };
    },
  },
  async tmdb(path, params) {
    tmdbCalls.push({ path, params });
    return tmdbHandler(path, params);
  },
  error: (code, message, opts) => new KinoError(code, message, opts),
  async fetch(url, opts = {}) {
    const call = { url, method: opts.method, headers: opts.headers || {}, body: opts.body };
    fetchCalls.push(call);
    const { status = 200, body } = await fetchHandler(call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, url, headers: {}, text: () => text, json: () => JSON.parse(text) };
  },
};

const { importAll, toLight } = await import("./light.mjs");
const importCatalog = (cat) => importAll(JSON.stringify(toLight(cat)));
const contract = await import("../src/contract/index.js");
const { home, search, browse, details, episodes, resolve } = contract;
const plugin = await import("../src/plugin.js");

const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const GRANTS = { catalog: "ca_catalog_grant", "catalog-value": "ca_value_grant" };
const CATALOG = {
  movies: [
    { id: 15066, type: 1, nameFile: "Walking Tall: The Payback", date: "2007-06-01", generos: "28,53", urlImage: "/walking.jpg" },
    { id: 603, type: 1, nameFile: "The Matrix", date: "1999-03-31", generos: "28,878", urlImage: "/matrix.jpg" },
  ],
  series: [
    { id: 801, type: 3, nameFile: "Anime Movie", date: "2020-01-01", generos: "16", urlImage: "/anime.jpg" },
    { id: 52814, type: 2, nameFile: "Halo", date: "2022-03-24", generos: "10765", urlImage: "/halo.jpg" },
    { id: 4000, type: 5, nameFile: "La Telenovela", date: "2021-05-05", generos: "18", urlImage: "/tele.jpg" },
  ],
};

const variantsBody = (variants) => ({ movieLinks: { variants } });
const route = (call) => call.url.slice("https://api.appsxploit.dev".length);

beforeEach(async () => {
  store.clear();
  rows.clear();
  fetchCalls = [];
  tmdbCalls = [];
  config = {};
  fetchHandler = () => { throw new Error("no fetch handler"); };
  tmdbHandler = () => { throw new Error("no tmdb handler"); };
  store.set("movp:identity:v1", JSON.stringify({
    n: vectors.key.n_hex, e: vectors.key.e, d: vectors.key.d_hex,
    spkiB64: vectors.key.spki_b64, installationId: vectors.installationId, deviceId: DEVICE_ID,
  }));
  store.set("movp:session:v1", JSON.stringify({
    sessionToken: "SESSION", grants: GRANTS, deviceId: DEVICE_ID, expiresAtMs: Date.now() + 3600000,
  }));
  store.set("movp:recipe:v1", JSON.stringify({ at: Date.now(), recipe: {
    apiBase: "https://api.appsxploit.dev", appVersion: "17.4", versionCode: 90355, channel: "prod", settingsProfile: 7,
    reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
  } }));
  await importCatalog(CATALOG);
});

test("plugin.js re-exports the real contract", () => {
  for (const name of ["home", "search", "browse", "details", "episodes", "resolve"]) assert.equal(plugin[name], contract[name], name);
});

test("search: finds Halo by name as a series card; empty query yields nothing", async () => {
  const hits = await search("halo");
  const halo = hits.find((h) => h.ref === "s:52814");
  assert.ok(halo);
  assert.equal(halo.kind, "series");
  assert.equal(halo.title, "Halo");
  assert.equal(halo.year, 2022);
  assert.equal(halo.poster, "https://image.tmdb.org/t/p/w342/halo.jpg");
  assert.deepEqual(halo.ids, { tmdb: 52814 });
  assert.match(halo.id, /^[A-Za-z0-9._~-]{1,128}$/);
  assert.deepEqual(await search("   "), []);
  assert.deepEqual(await search({ q: "matrix" }).then((r) => r.map((x) => x.ref)), ["m:603"]);
  assert.equal(tmdbCalls.length, 0, "search never touches TMDB");
});

test("details: movie and series from kino.tmdb", async () => {
  tmdbHandler = (path) => path === "/movie/15066"
    ? { id: 15066, title: "Walking Tall", overview: "Plot", poster_path: "/p.jpg", backdrop_path: "/b.jpg", genres: [{ name: "Acción" }], release_date: "2007-06-01", vote_average: 5.64, runtime: 90 }
    : { id: 52814, name: "Halo", overview: "Series plot", poster_path: "/hp.jpg", backdrop_path: "/hb.jpg", genres: [{ name: "Sci-Fi" }], first_air_date: "2022-03-24", vote_average: 8.04 };
  const m = await details("m:15066");
  assert.deepEqual(m, {
    title: "Walking Tall", poster: "https://image.tmdb.org/t/p/w500/p.jpg", backdrop: "https://image.tmdb.org/t/p/w1280/b.jpg",
    overview: "Plot", genres: ["Acción"], year: 2007, rating: 5.6, ids: { tmdb: 15066 }, runtimeMinutes: 90,
  });
  const s = await details("s:52814");
  assert.equal(s.title, "Halo");
  assert.equal(s.year, 2022);
  assert.deepEqual(s.ids, { tmdb: 52814 });
  assert.deepEqual(tmdbCalls.map((c) => c.path), ["/movie/15066", "/tv/52814"]);
  assert.equal(tmdbCalls[0].params.language, "es-MX");
  assert.equal(await details("e:1:1:1"), null);
});

test("details: TMDB 404 is not_found, other failures are unavailable", async () => {
  tmdbHandler = () => { throw new KinoError("not_found", "x"); };
  await assert.rejects(() => details("m:1"), (e) => e.code === "not_found");
  tmdbHandler = () => { throw new KinoError("network", "x"); };
  await assert.rejects(() => details("m:1"), (e) => e.code === "unavailable");
});

test("episodes: Halo from the series document, named by TMDB", async () => {
  fetchHandler = () => ({ body: documentTv });
  tmdbHandler = (path, params) => {
    assert.equal(path, "/tv/52814");
    assert.equal(params.append_to_response, "season/1,season/2");
    return {
      id: 52814, name: "Halo", poster_path: "/hp.jpg", first_air_date: "2022-03-24",
      "season/1": { episodes: [{ episode_number: 1, name: "Contacto", still_path: "/s1.jpg", air_date: "2022-03-24", runtime: 60, overview: "o" }] },
      "season/2": { episodes: [] },
    };
  };
  const res = await episodes("s:52814");
  assert.equal(res.series.title, "Halo");
  assert.equal(res.episodes.length, 17);
  assert.deepEqual(res.episodes[0], {
    season: 1, number: 1, ref: "e:52814:1:1", title: "Contacto", still: "https://image.tmdb.org/t/p/w300/s1.jpg",
    overview: "o", airDate: "2022-03-24", runtimeMinutes: 60,
  });
  assert.equal(res.episodes[1].title, "Episodio 2");
  assert.deepEqual(res.episodes.slice(8, 10).map((e) => e.ref), ["e:52814:1:9", "e:52814:2:1"]);
  assert.equal(fetchCalls.filter((c) => route(c) === "/v2/client/playback").length, 0, "listing never resolves tokens");
});

test("episodes: without TMDB the episodes are still listed, numbered", async () => {
  fetchHandler = () => ({ body: documentTv });
  tmdbHandler = () => { throw new KinoError("network", "down"); };
  const res = await episodes("s:52814");
  assert.equal(res.series, undefined);
  assert.equal(res.episodes.length, 17);
  assert.equal(res.episodes[0].ref, "e:52814:1:1");
  assert.equal(res.episodes[0].title, "Episodio 1");
  await assert.rejects(() => episodes("m:1"), (e) => e.code === "not_found");
});

const playbackHandler = (call) => {
  if (route(call) === "/v2/client/movie-variants") return { body: movieVariants };
  if (route(call) === "/v2/client/document") return { body: documentTv };
  if (route(call) === "/v2/client/playback") return { body: playback };
  throw new Error("unexpected " + route(call));
};
const played = () => fetchCalls.filter((c) => route(c) === "/v2/client/playback").map((c) => JSON.parse(c.body).token);

test("resolve movie: resolves the token at play time; 1080p default, the rest as lazy alternatives", async () => {
  fetchHandler = playbackHandler;
  const st = await resolve("m:15066");
  assert.match(st.url, /mds\.storage\.yandex\.net/);
  assert.equal(st.label, "1080p DUAL · 6.83 GB");
  assert.deepEqual(st.alternatives, [{ label: "CAST · 529.64 MB", ref: "m:15066#CAST" }]);
  assert.deepEqual(played(), ["Movp2!::cv-20261027-0c585f4dfc8b.FAKEPART0002.FAKESIGNATURE0002"]);
});

test("resolve episode: Halo S01E01 defaults to 1080p, not 4K; alternatives list 4K and 720p", async () => {
  fetchHandler = playbackHandler;
  const st = await resolve("e:52814:1:1");
  assert.match(st.url, /mds\.storage\.yandex\.net/);
  assert.match(st.label, /^1080p · 2\.98 GB$/);
  assert.deepEqual(st.alternatives.map((a) => a.ref), ["e:52814:1:1#4K", "e:52814:1:1#720p"]);
  assert.equal(played().length, 1);
  assert.equal(played()[0], documentTv.data["Temporada 01/1080p"][0].split("_SPLIT_")[1]);
});

test("resolve: maxQuality setting caps the default; a #quality ref picks that copy", async () => {
  fetchHandler = playbackHandler;
  config = { maxQuality: "720p" };
  let st = await resolve("e:52814:1:1");
  assert.match(st.label, /^720p/);
  config = { maxQuality: "auto" };
  st = await resolve("e:52814:1:1#4K");
  assert.match(st.label, /^4K/);
  assert.equal(played()[1], documentTv.data["Temporada 01/4K"][0].split("_SPLIT_")[1]);
  st = await resolve("m:15066#CAST");
  assert.match(st.label, /^CAST/);
});

test("resolve: only 4K available → plays it rather than failing", async () => {
  fetchHandler = (call) => route(call) === "/v2/client/playback" ? { body: playback }
    : { body: variantsBody(["4K,_,10 GB,_,Movp2!::cv-x.a.b"]) };
  const st = await resolve("m:1");
  assert.match(st.label, /^4K/);
  assert.equal(st.alternatives, undefined);
});

test("resolve: stale token (unavailable) → variants re-fetched once and the new token is played", async () => {
  let variantsCalls = 0;
  let playbackCalls = 0;
  fetchHandler = (call) => {
    if (route(call) === "/v2/client/movie-variants") {
      variantsCalls++;
      const tok = variantsCalls === 1 ? "STALE" : "FRESH";
      return { body: variantsBody([`1080p DUAL,_,6.83 GB,_,Movp2!::cv-x.${tok}.sig`, `CAST,_,1 GB,_,Movp2!::cv-x.c${variantsCalls}.sig`]) };
    }
    playbackCalls++;
    return playbackCalls === 1 ? { body: { status: "expired" } } : { body: playback };
  };
  const st = await resolve("m:15066");
  assert.match(st.url, /mds\.storage\.yandex\.net/);
  assert.equal(variantsCalls, 2);
  assert.deepEqual(played(), ["Movp2!::cv-x.STALE.sig", "Movp2!::cv-x.FRESH.sig"]);
});

test("resolve: a second unavailable is not retried again", async () => {
  fetchHandler = (call) => route(call) === "/v2/client/playback" ? { body: { status: "expired" } } : playbackHandler(call);
  await assert.rejects(() => resolve("m:15066"), (e) => e.code === "unavailable");
  assert.equal(played().length, 2);
});

test("resolve: bad refs and missing episodes are not_found", async () => {
  fetchHandler = playbackHandler;
  await assert.rejects(() => resolve("s:52814"), (e) => e.code === "not_found");
  await assert.rejects(() => resolve("zzz"), (e) => e.code === "not_found");
  await assert.rejects(() => resolve("e:52814:9:9"), (e) => e.code === "not_found");
  assert.equal(played().length, 0);
});

test("browse: a category pages newest first with a cursor", async () => {
  const res = await browse("peliculas", null);
  assert.deepEqual(res.items.map((i) => i.ref), ["m:15066", "m:603"]);
  assert.equal(res.next, undefined);
  const cards = await browse("animes");
  assert.deepEqual(cards.items.map((i) => i.ref), ["s:801"]);
  const tele = await browse("telenovelas");
  assert.deepEqual(tele.items.map((i) => i.ref), ["s:4000"]);
});

test("browse: pagination continues from next across the whole catalog", async () => {
  const many = { movies: [], series: [] };
  for (let i = 1; i <= 130; i++) many.movies.push({ id: 100000 + i, type: 1, nameFile: "Movie " + i, date: `2000-01-${String((i % 28) + 1).padStart(2, "0")}`, urlImage: "/x.jpg" });
  many.series.push({ id: 5, type: 2, nameFile: "Only series", date: "1990-01-01" });
  rows.clear();
  await importCatalog(many);
  const p1 = await browse("peliculas", null);
  assert.equal(p1.items.length, 20);
  assert.ok(p1.next);
  const p2 = await browse("peliculas", p1.next);
  assert.equal(p2.items.length, 20);
  assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.ref)).size, 40);
  const series = await browse("series", null);
  assert.deepEqual(series.items.map((i) => i.ref), ["s:5"]);
  assert.equal(series.next, undefined);
});

test("browse: genre refs filter within the category; unknown refs are not_found", async () => {
  const res = await browse("peliculas:878");
  assert.deepEqual(res.items.map((i) => i.ref), ["m:603"]);
  await assert.rejects(() => browse("nope"), (e) => e.code === "not_found");
});

test("browse duanju: empty category answers {items:[]} without throwing", async () => {
  assert.deepEqual(await browse("duanju", null), { items: [] });
  assert.deepEqual(await browse("duanju"), { items: [] });
});

test("home: a 'recent' row per non-empty category, none for Duanju; empty before the first import", async () => {
  const rows_ = await home();
  assert.deepEqual(rows_.map((r) => r.ref), ["peliculas", "series", "animes", "telenovelas"]);
  assert.deepEqual(rows_[0].items.map((i) => i.ref), ["m:15066", "m:603"]);
  assert.match(rows_[0].title, /Películas/);
  assert.equal(rows_[2].genre, "anime");
  assert.equal(tmdbCalls.length, 0, "home never touches TMDB");
  assert.equal(fetchCalls.length, 0, "home never resolves anything");
  store.clear();
  assert.deepEqual(await home(), []);
});
