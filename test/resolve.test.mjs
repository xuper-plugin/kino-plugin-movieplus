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
let fetchCalls = [];
let fetchHandler = () => { throw new Error("no fetch handler"); };

class KinoError extends Error {
  constructor(code, message, opts) {
    super(message);
    this.code = code;
    if (opts && opts.userMessage) this.userMessage = opts.userMessage;
  }
}

globalThis.kino = {
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
  error: (code, message, opts) => new KinoError(code, message, opts),
  async fetch(url, opts = {}) {
    const call = { url, method: opts.method, headers: opts.headers || {}, body: opts.body };
    fetchCalls.push(call);
    const { status = 200, body } = await fetchHandler(call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, url, headers: {}, text: () => text, json: () => JSON.parse(text) };
  },
};

const { movieStreams, seriesDocument, resolveToken } = await import("../src/movp/resolve.js");

const API = "https://api.appsxploit.dev";
const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const GRANTS = { catalog: "ca_catalog_grant", "catalog-value": "ca_value_grant" };
const sentBody = (i = 0) => JSON.parse(fetchCalls[i].body);
const path = (i = 0) => fetchCalls[i].url.slice(API.length);

beforeEach(() => {
  store.clear();
  fetchCalls = [];
  store.set("movp:identity:v1", JSON.stringify({
    n: vectors.key.n_hex, e: vectors.key.e, d: vectors.key.d_hex,
    spkiB64: vectors.key.spki_b64, installationId: vectors.installationId, deviceId: DEVICE_ID,
  }));
  store.set("movp:session:v1", JSON.stringify({
    sessionToken: "SESSION", grants: GRANTS, deviceId: DEVICE_ID, expiresAtMs: Date.now() + 3600000,
  }));
  store.set("movp:recipe:v1", JSON.stringify({ at: Date.now(), recipe: {
    apiBase: API, appVersion: "17.4", versionCode: 90355, channel: "prod", settingsProfile: 7,
    reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
  } }));
});

test("movieStreams: movie-variants with the catalog grant, parsed into quality/size/token", async () => {
  fetchHandler = () => ({ body: movieVariants });
  const streams = await movieStreams(15066);

  assert.equal(fetchCalls.length, 1);
  assert.equal(path(), "/v2/client/movie-variants");
  assert.deepEqual(sentBody(), { schemaVersion: 1, deviceId: DEVICE_ID, grantId: GRANTS.catalog, movieId: 15066 });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((s) => s.quality), ["CAST", "1080p DUAL"]);
  assert.deepEqual(streams.map((s) => s.size), ["529.64 MB", "6.83 GB"]);
  for (const s of streams) {
    assert.ok(s.quality && s.size && s.token);
    assert.ok(s.token.startsWith("Movp2!::"));
  }
});

test("movieStreams: a numeric-string id is sent as an integer; bad ids are rejected before any request", async () => {
  fetchHandler = () => ({ body: movieVariants });
  await movieStreams("15066");
  assert.strictEqual(sentBody().movieId, 15066);
  await assert.rejects(() => movieStreams("abc"), (e) => e.code === "invalid_request");
  await assert.rejects(() => movieStreams(0), (e) => e.code === "invalid_request");
  assert.equal(fetchCalls.length, 1);
});

test("movieStreams: no variants → not_found; malformed variants are skipped", async () => {
  fetchHandler = () => ({ body: { movieLinks: { variants: [] } } });
  await assert.rejects(() => movieStreams(1), (e) => e.code === "not_found");
  fetchHandler = () => ({ body: { movieLinks: { variants: ["garbage", "720p,_,1 GB,_,Movp2!::cv-x.a.b", "1080p,_,2 GB,_,"] } } });
  const streams = await movieStreams(1);
  assert.deepEqual(streams, [{ quality: "720p", size: "1 GB", token: "Movp2!::cv-x.a.b" }]);
});

test("seriesDocument: document request shape (collection tv, catalog grant, fresh uuid)", async () => {
  fetchHandler = () => ({ body: documentTv });
  await seriesDocument(52814);
  assert.equal(path(), "/v2/client/document");
  const b = sentBody();
  assert.equal(b.schemaVersion, 1);
  assert.equal(b.deviceId, DEVICE_ID);
  assert.equal(b.grantId, GRANTS.catalog);
  assert.equal(b.collection, "tv");
  assert.equal(b.documentId, "52814");
  assert.equal(b.minVersion, 0);
  assert.match(b.freshRequest, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("seriesDocument (Halo): season 1 has 9 episodes with S01E01 parsed and per-quality tokens", async () => {
  fetchHandler = () => ({ body: documentTv });
  const { seasons } = await seriesDocument(52814);

  assert.deepEqual([...seasons.keys()], [1, 2]);
  const s1 = seasons.get(1);
  assert.equal(s1.length, 9);
  assert.deepEqual(s1.map((ep) => ep.e), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const ep of s1) {
    assert.equal(ep.s, 1);
    assert.ok(ep.token.startsWith("Movp2!::"));
    assert.equal(ep.variants.length, 3);
  }
  const e1 = s1[0];
  assert.equal(e1.name, "Halo 4K S01E01.mkv");
  assert.equal(e1.quality, "4K", "default entry is the highest quality");
  assert.deepEqual(e1.variants.map((v) => v.quality), ["4K", "1080p", "720p"]);
  assert.deepEqual(e1.variants[0], { quality: "4K", token: e1.token, size: e1.size, name: "Halo 4K S01E01.mkv" });
  const v1080 = e1.variants.find((v) => v.quality === "1080p");
  assert.equal(v1080.size, "3197591702");
  assert.equal(v1080.token, documentTv.data["Temporada 01/1080p"][0].split("_SPLIT_")[1]);
  assert.equal(seasons.get(2).length, 8);
});

test("seriesDocument: a name without SxxEyy gets a sequential number inside its season key (not dropped)", async () => {
  const data = {
    "Temporada 03/1080p": [
      "Show 1080p S03E01.mkv_SPLIT_Movp2!::cv-a.1.1_SPLIT_100",
      "Capitulo especial.mkv_SPLIT_Movp2!::cv-a.2.2_SPLIT_200",
      "Show 1080p S03E03.mkv_SPLIT_Movp2!::cv-a.3.3_SPLIT_300_FOLDER_extras",
      "Otro sin numero.mkv_SPLIT_Movp2!::cv-a.4.4_SPLIT_400",
    ],
  };
  fetchHandler = () => ({ body: { path: "tv/9", data } });
  const { seasons } = await seriesDocument(9);
  const s3 = seasons.get(3);
  assert.equal(s3.length, 4);
  assert.deepEqual(s3.map((ep) => ep.e), [1, 2, 3, 4]);
  assert.ok(s3.every((ep) => ep.s === 3));
  assert.equal(s3[1].name, "Capitulo especial.mkv");
  assert.equal(s3[1].token, "Movp2!::cv-a.2.2");
  assert.equal(s3[2].size, "300", "_FOLDER_ suffix is not part of the size");
  assert.equal(s3[3].token, "Movp2!::cv-a.4.4");
});

test("seriesDocument: fallback numbers never collide with parsed episodes; quality variants line up by number", async () => {
  const data = {
    "Temporada 01/720p": ["Intro.mkv_SPLIT_Movp2!::cv-a.1.1_SPLIT_1", "X S01E01.mkv_SPLIT_Movp2!::cv-a.2.2_SPLIT_2"],
    "Temporada 01/1080p": ["X S01E01.mkv_SPLIT_Movp2!::cv-a.3.3_SPLIT_3"],
  };
  fetchHandler = () => ({ body: { data } });
  const { seasons } = await seriesDocument(9);
  const s1 = seasons.get(1);
  assert.deepEqual(s1.map((ep) => ep.e), [1, 2]);
  assert.deepEqual(s1[0].variants.map((v) => v.quality), ["1080p", "720p"]);
  assert.equal(s1[1].name, "Intro.mkv");
  assert.equal(s1[1].variants.length, 1);
});

test("seriesDocument: empty or missing data → not_found; bad ids rejected", async () => {
  fetchHandler = () => ({ body: { path: "tv/9", data: {} } });
  await assert.rejects(() => seriesDocument(9), (e) => e.code === "not_found");
  fetchHandler = () => ({ body: { path: "tv/9" } });
  await assert.rejects(() => seriesDocument(9), (e) => e.code === "not_found");
  await assert.rejects(() => seriesDocument("12x"), (e) => e.code === "invalid_request");
});

test("resolveToken: playback with the catalog-value grant returns the direct Yandex CDN url", async () => {
  fetchHandler = () => ({ body: playback });
  const before = Date.now();
  const url = await resolveToken("Movp2!::cv-x.a.b");
  const after = Date.now();

  assert.equal(path(), "/v2/client/playback");
  const b = sentBody();
  assert.equal(b.schemaVersion, 1);
  assert.equal(b.deviceId, DEVICE_ID);
  assert.equal(b.grantId, GRANTS["catalog-value"]);
  assert.equal(b.token, "Movp2!::cv-x.a.b");
  assert.strictEqual(b.resolveProvider, true);
  assert.equal(b.issuedAtMs % 1000, 0);
  assert.ok(b.issuedAtMs >= Math.floor(before / 1000) * 1000 - 1000 && b.issuedAtMs <= Math.floor(after / 1000) * 1000 - 1000);
  assert.ok(url.startsWith("https://mds.storage.yandex.net/"));
  assert.equal(url, playback.value);
});

test("resolveToken(token, false) asks for the provider link instead", async () => {
  fetchHandler = () => ({ body: { ...playback, value: "https://yadi.sk/i/XXXX" } });
  assert.equal(await resolveToken("Movp2!::cv-x.a.b", false), "https://yadi.sk/i/XXXX");
  assert.strictEqual(sentBody().resolveProvider, false);
});

test("resolveToken: status other than resolved, or no value → kino.error unavailable with a userMessage", async () => {
  for (const body of [{ status: "pending", ok: true }, { status: "denied" }, { status: "resolved", ok: true }, { status: "resolved", value: "" }, {}]) {
    fetchHandler = () => ({ body });
    await assert.rejects(() => resolveToken("Movp2!::cv-x.a.b"), (e) => {
      assert.equal(e.code, "unavailable");
      assert.ok(e.userMessage && e.userMessage.length <= 160);
      return true;
    });
  }
});

test("resolveToken: rejects tokens that are not Movp2 before any request", async () => {
  await assert.rejects(() => resolveToken(""), (e) => e.code === "invalid_request");
  await assert.rejects(() => resolveToken("https://example.com/x.mkv"), (e) => e.code === "invalid_request");
  assert.equal(fetchCalls.length, 0);
});
