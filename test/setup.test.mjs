import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const sampleGz = readFileSync(new URL("./fixtures/items-sample.json.gz", import.meta.url));
const sample = JSON.parse(gunzipSync(sampleGz).toString("utf8"));
const SAMPLE_TOTAL = sample.movies.length + sample.series.length;
const manifest = JSON.parse(readFileSync(new URL("../kino-plugin.json", import.meta.url), "utf8"));

const RECIPE = {
  apiBase: "https://api.appsxploit.dev", appVersion: "17.4", versionCode: 90355, channel: "prod",
  settingsProfile: 7, reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
};

const store = new Map();
const rows = new Map();
let vaultCalls = 0;
let vaultAnswer = RECIPE;
let fetchHandler = () => ({ status: 200, bytes: sampleGz });

class KinoError extends Error { constructor(code, message, extra) { super(message); this.code = code; if (extra) Object.assign(this, extra); } }

globalThis.kino = {
  crypto: { gunzip: (data) => gunzipSync(Buffer.from(data, "base64")).toString("utf8") },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, String(v)); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  catalog: {
    async upsert(items) { for (const it of items) rows.set(it.id, { ...it }); return { count: items.length }; },
    async get(ids) { return ids.filter((i) => rows.has(i)).map((i) => rows.get(i)); },
    async count() { return rows.size; },
  },
  vault: {
    async get() {
      vaultCalls++;
      if (vaultAnswer instanceof Error) throw vaultAnswer;
      return vaultAnswer;
    },
  },
  error: (code, message, extra) => new KinoError(code, message, extra),
  async fetch(url) {
    const { status = 200, bytes, headers = {} } = await fetchHandler(url);
    return { ok: status >= 200 && status < 300, status, url, headers, base64: () => Buffer.from(bytes || []).toString("base64") };
  },
};

const plugin = await import("../src/plugin.js");
const { screen, screenEvent } = plugin;

beforeEach(() => {
  delete globalThis.kino.lang;
  store.clear();
  rows.clear();
  vaultCalls = 0;
  vaultAnswer = RECIPE;
  fetchHandler = () => ({ status: 200, bytes: sampleGz });
});

async function runAll(maxSteps = 60) {
  const out = [];
  for (let step = 0; step < maxSteps; step++) {
    const r = await plugin.setupRun({ step });
    out.push(r);
    if (r.done) return out;
  }
  throw new Error("setupRun never finished");
}

test("manifest declares setup route under enhancements 30 and keeps the current apiVersion", () => {
  // Kino's setup is apiVersion 30 (29 is go.relinkTelegram): a Kino at 29 ignores the block.
  assert.deepEqual(manifest.enhancements, { 30: { setup: { route: "setup" } } });
  assert.ok(manifest.apiVersion < 30);
  assert.ok(manifest.capabilities.includes("screen"));
});

test("setupStatus: not ready without a recipe or with an empty catalog", async () => {
  assert.equal((await plugin.setupStatus()).ready, false);
  await runAll(); // fully set up…
  store.delete("movp:recipe:v1"); // …cache expiry alone must not flip it back (the marker persists)
  assert.equal((await plugin.setupStatus()).ready, true);
  rows.clear();
  assert.equal((await plugin.setupStatus()).ready, false, "empty catalog = not ready");
});

test("setupStatus never touches kino.vault or kino.identity", async () => {
  await plugin.setupStatus();
  assert.equal(vaultCalls, 0);
});

test("setupStatus is ready once the recipe is readable and the catalog imported", async () => {
  await runAll();
  const s = await plugin.setupStatus();
  assert.equal(s.ready, true);
});

test("setupRun step 0 reads the recipe with kino.vault.get()", async () => {
  const r = await plugin.setupRun({ step: 0 });
  assert.equal(vaultCalls, 1);
  assert.equal(r.done, false);
  assert.equal(rows.size, 0, "step 0 imports nothing");
});

test("setupRun: recipe, download, one batch per call, then done; the catalog is imported", async () => {
  const steps = await runAll();
  assert.equal(steps.at(-1).done, true);
  assert.equal(rows.size, SAMPLE_TOTAL);
  assert.ok(steps.length >= 3);
  for (const s of steps.slice(0, -1)) assert.equal(s.done, false);
  const progress = steps.map((s) => s.progress).filter((p) => p != null);
  assert.ok(progress.every((p) => p >= 0 && p <= 1));
  assert.equal(vaultCalls, 1, "recipe cached after step 0");
});

test("setupRun resumes after a restart: the cursor lives in kino.storage", async () => {
  await plugin.setupRun({ step: 0 });
  await plugin.setupRun({ step: 1 }); // download + store raw
  const r = await plugin.setupRun({ step: 7 }); // a fresh call (step number is irrelevant) continues the import
  assert.ok(r.done === true || r.done === false);
  let guard = 0;
  let last = r;
  while (!last.done && guard++ < 60) last = await plugin.setupRun({ step: 8 + guard });
  assert.equal(last.done, true);
  assert.equal(rows.size, SAMPLE_TOTAL);
});

test("setupRun: a vault refusal is a step error with a label", async () => {
  vaultAnswer = new KinoError("not_member", "no");
  await assert.rejects(() => plugin.setupRun({ step: 0 }), (e) => e.code === "not_member" && /Movie\+/.test(e.userMessage || ""));
  assert.equal(rows.size, 0);
});

test("setupRun: a failed download is a step error, not done", async () => {
  fetchHandler = () => ({ status: 500, bytes: Buffer.alloc(0) });
  await plugin.setupRun({ step: 0 });
  await assert.rejects(() => plugin.setupRun({ step: 1 }), (e) => e.code === "unavailable");
  assert.equal((await plugin.setupStatus()).ready, false);
});

test("setupRun is done at once when already set up", async () => {
  await runAll();
  assert.equal((await plugin.setupRun({ step: 0 })).done, true);
});

test("the screen answers route setup with the gate, and open runs the same setup", async () => {
  // Kino hands the route as an object, { name, params, args }.
  const v = await screen({ route: { name: "setup", params: {} }, state: {} });
  assert.equal(v.type, "Scaffold");
  const a = await screenEvent({ name: "open", state: {}, route: { name: "setup", params: {} } });
  assert.equal(a.state.downloading, true);
  assert.equal(vaultCalls, 1);
});

test("the setup lines and a failed step's sentence follow Kino's language", async () => {
  globalThis.kino.lang = "en-US";
  assert.equal((await plugin.setupStatus()).label, "Movie+ needs to download its catalog");
  assert.equal((await plugin.setupRun({ step: 0 })).label, "Activating Movie+…");
  fetchHandler = () => ({ status: 500, bytes: Buffer.alloc(0) });
  const e = await plugin.setupRun({ step: 1 }).catch((x) => x);
  assert.equal(e.code, "unavailable");
  assert.equal(e.userMessage, "Could not download the catalog, check your connection and try again");
  globalThis.kino.lang = "es-CO";
  assert.equal((await plugin.setupStatus()).label, "Movie+ necesita descargar su catálogo");
});
