import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const sampleGz = readFileSync(new URL("./fixtures/items-sample.json.gz", import.meta.url));
const sample = JSON.parse(gunzipSync(sampleGz).toString("utf8"));
const SAMPLE_TOTAL = sample.items.length;
const { lightGz } = await import("./light.mjs");

const store = new Map();
const rows = new Map();
let fetchHandler = () => ({ status: 200, bytes: sampleGz });
let maxValueBytes = Infinity;

class KinoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

globalThis.kino = {
  crypto: {
    gunzip: (data) => gunzipSync(Buffer.from(data, "base64")).toString("utf8"),
  },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => {
      if (Buffer.byteLength(String(v)) > maxValueBytes) throw new KinoError("too_large", "plugin storage full (2 MB per value)");
      store.set(k, String(v));
    },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  catalog: {
    async upsert(items) { for (const it of items) rows.set(it.id, { ...it }); return { count: items.length }; },
    async get(ids) { return ids.filter((i) => rows.has(i)).map((i) => rows.get(i)); },
    async count() { return rows.size; },
  },
  error: (code, message) => new KinoError(code, message),
  async fetch(url) {
    const { status = 200, bytes, headers = {} } = await fetchHandler(url);
    return { ok: status >= 200 && status < 300, status, url, headers, base64: () => Buffer.from(bytes || []).toString("base64") };
  },
};

const { gateView, handleGateEvent, needsGate, GATE_EVENTS } = await import("../src/screen/gate.js");

beforeEach(() => {
  store.clear();
  rows.clear();
  fetchHandler = () => ({ status: 200, bytes: sampleGz });
  maxValueBytes = Infinity;
});

function find(node, pred, out = []) {
  if (node && typeof node === "object") {
    if (pred(node)) out.push(node);
    for (const v of Object.values(node)) find(v, pred, out);
  }
  return out;
}

test("gateView idle: Movie+ title and a Descargar catálogo button wired to download", () => {
  const v = gateView({ phase: "idle" });
  assert.equal(v.type, "Scaffold");
  assert.equal(v.appBar.title, "Movie+");
  const [btn] = find(v, (n) => n.type === "ElevatedButton");
  assert.equal(btn.onPressed, "download");
  assert.equal(btn.labelText, "Descargar catálogo");
  assert.equal(btn.labelTextEn, "Download catalog");
  assert.equal(v.every, undefined);
});

test("gateView downloading: indeterminate bar and a fetchCatalog tick", () => {
  const v = gateView({ phase: "downloading" });
  const [bar] = find(v, (n) => n.type === "LinearProgressIndicator");
  assert.ok(bar);
  assert.equal(bar.value, undefined);
  assert.deepEqual(v.every, [{ ms: 1000, event: "fetchCatalog" }]);
  assert.equal(find(v, (n) => n.type === "ElevatedButton").length, 0);
});

test("gateView importing: determinate bar and an importTick tick", () => {
  const v = gateView({ phase: "importing", cursor: 10, total: 100 });
  const [bar] = find(v, (n) => n.type === "LinearProgressIndicator");
  assert.equal(bar.value, 0.1);
  assert.equal(bar.labelText, "Importando catálogo… 10 / 100");
  assert.equal(bar.labelTextEn, "Importing catalog… 10 / 100");
  assert.deepEqual(v.every, [{ ms: 1000, event: "importTick" }]);
  assert.equal(gateView({ phase: "importing" }).body.children.find((c) => c.type === "LinearProgressIndicator").value, 0);
});

test("gateView loading: spinner, no tick", () => {
  const v = gateView({ phase: "loading" });
  assert.equal(find(v, (n) => n.type === "CircularProgressIndicator").length, 1);
  assert.equal(v.every, undefined);
});

test("gateView derives the phase from the state flags when none is given", () => {
  assert.deepEqual(gateView({ downloading: true }).every, [{ ms: 1000, event: "fetchCatalog" }]);
  assert.deepEqual(gateView({ importing: true, cursor: 1, total: 2 }).every, [{ ms: 1000, event: "importTick" }]);
  assert.equal(find(gateView({}), (n) => n.type === "CircularProgressIndicator").length, 1);
  assert.equal(find(gateView({ ready: true, empty: true }), (n) => n.type === "ElevatedButton").length, 1);
});

test("needsGate and GATE_EVENTS", () => {
  assert.equal(needsGate({}), true);
  assert.equal(needsGate({ downloading: true, ready: true }), true);
  assert.equal(needsGate({ importing: true, ready: true }), true);
  assert.equal(needsGate({ ready: true, empty: true }), true);
  assert.equal(needsGate({ ready: true }), false);
  for (const e of ["open", "download", "fetchCatalog", "importTick"]) assert.ok(GATE_EVENTS.has(e), e);
  assert.ok(!GATE_EVENTS.has("tab"));
});

test("open with an empty catalog starts downloading", async () => {
  assert.deepEqual(await handleGateEvent("open", null, {}), { state: { ready: true, downloading: true } });
});

test("open with an installed catalog is simply ready", async () => {
  await kino.catalog.upsert([{ id: "m:1", title: "x" }]);
  store.set("movp:catalog:v1", JSON.stringify({ at: 1, total: 1 }));
  assert.deepEqual(await handleGateEvent("open", null, {}), { state: { ready: true, downloading: false, importing: false, empty: false } });
});

test("open with rows but no finished import re-downloads", async () => {
  await kino.catalog.upsert([{ id: "m:1", title: "x" }]);
  assert.deepEqual(await handleGateEvent("open", null, {}), { state: { ready: true, downloading: true } });
});

test("download flips to the downloading phase", async () => {
  assert.deepEqual(await handleGateEvent("download", null, {}), { state: { downloading: true } });
});

test("fetchCatalog ok: stores the raw catalog and starts importing with the total", async () => {
  const r = await handleGateEvent("fetchCatalog", null, { downloading: true });
  assert.deepEqual(r, { state: { downloading: false, importing: true, cursor: 0, total: SAMPLE_TOTAL } });
  assert.ok(store.size > 0);
});

test("fetchCatalog fail: back to the button with an error toast", async () => {
  fetchHandler = () => ({ status: 500 });
  const r = await handleGateEvent("fetchCatalog", null, { downloading: true });
  assert.deepEqual(r.state, { downloading: false, ready: true, empty: true });
  assert.deepEqual(r.toast, { text: "No se pudo descargar; reintenta", textEn: "Download failed; try again", role: "error" });
  assert.equal(store.size, 0);
});

test("the raw catalog is split so no storage value passes the per-value cap", async () => {
  const big = { movies: Array.from({ length: 30000 }, (_, i) => ({ id: i + 1, type: 1, nameFile: "Título " + i, date: "2024-01-01", urlImage: "https://x/" + i + ".jpg" })), series: [] };
  assert.ok(JSON.stringify(big).length > 1500000);
  fetchHandler = async () => ({ status: 200, bytes: lightGz(big) });
  maxValueBytes = 1200000;
  const r = await handleGateEvent("fetchCatalog", null, {});
  assert.equal(r.state.importing, true);
  assert.equal(r.state.total, 30000);
  const chunks = [...store.keys()].filter((k) => k.startsWith("movp:gate:raw:"));
  assert.ok(chunks.length >= 4);
  for (const v of store.values()) assert.ok(Buffer.byteLength(v) <= 1200000);
  const t = await handleGateEvent("importTick", null, { importing: true, cursor: 0, total: r.state.total });
  assert.equal(t.state.cursor, 500);
  assert.equal(rows.get("m:7").title, "Título 6");
});

test("fetchCatalog that cannot be stored fails cleanly and leaves no raw behind", async () => {
  maxValueBytes = 10;
  const r = await handleGateEvent("fetchCatalog", null, {});
  assert.equal(r.state.empty, true);
  assert.equal(r.toast.role, "error");
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith("movp:gate")), []);
});

test("importTick imports batch by batch until done, then leaves the gate and clears the raw", async () => {
  const f = await handleGateEvent("fetchCatalog", null, {});
  let state = { importing: true, cursor: 0, total: f.state.total };
  let r;
  let ticks = 0;
  do {
    r = await handleGateEvent("importTick", null, state);
    ticks++;
    assert.ok(ticks < 1000);
    if (!r.state.ready) {
      assert.equal(typeof r.state.cursor, "number");
      assert.equal(r.state.total, SAMPLE_TOTAL);
      state = { importing: true, ...r.state };
    }
  } while (!r.state.ready);
  assert.deepEqual(r.state, { importing: false, ready: true, imported: true, cursor: SAMPLE_TOTAL, total: SAMPLE_TOTAL, empty: false });
  assert.equal(rows.size, SAMPLE_TOTAL);
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith("movp:gate")), []);
  assert.equal(needsGate({ ...r.state }), false);
});

test("importTick imports in several batches when the catalog is bigger than a batch", async () => {
  const many = { movies: Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, type: 1, nameFile: "t" + i, date: "2024-01-01" })), series: [] };
  fetchHandler = async () => ({ status: 200, bytes: lightGz(many) });
  const f = await handleGateEvent("fetchCatalog", null, {});
  assert.equal(f.state.total, 1200);
  const r1 = await handleGateEvent("importTick", null, { importing: true, cursor: 0, total: 1200 });
  assert.equal(r1.state.ready, undefined);
  assert.ok(r1.state.cursor > 0 && r1.state.cursor < 1200);
  assert.equal(r1.state.total, 1200);
  let r = r1;
  while (!r.state.ready) r = await handleGateEvent("importTick", null, { importing: true, ...r.state });
  assert.equal(rows.size, 1200);
});

test("open resumes an import that was in flight", async () => {
  const many = { movies: Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, type: 1, nameFile: "t" + i, date: "2024-01-01" })), series: [] };
  fetchHandler = async () => ({ status: 200, bytes: lightGz(many) });
  await handleGateEvent("fetchCatalog", null, {});
  const r1 = await handleGateEvent("importTick", null, { importing: true, cursor: 0, total: 1200 });
  const o = await handleGateEvent("open", null, {});
  assert.deepEqual(o, { state: { ready: true, importing: true, cursor: r1.state.cursor, total: 1200 } });
});

test("importTick with nothing stored and no finished import falls back to the button", async () => {
  const r = await handleGateEvent("importTick", null, { importing: true, cursor: 3, total: 9 });
  assert.deepEqual(r.state, { importing: false, ready: true, empty: true });
});

test("unknown events are not handled", async () => {
  assert.equal(await handleGateEvent("tab", "series", {}), null);
});

test("open re-downloads a catalog the scheduled job flagged as changed, and the import clears the flag", async () => {
  rows.set("m:1", { id: "m:1" });
  store.set("movp:catalog:v1", JSON.stringify({ at: 1, total: 1 }));
  store.set("movp:catalog:pending:v1", "1");
  const opened = await handleGateEvent("open", null, {});
  assert.equal(opened.state.downloading, true);
  await handleGateEvent("fetchCatalog", null, {});
  let r;
  do { r = await handleGateEvent("importTick", null, {}); } while (r.state.importing !== false);
  assert.equal(store.has("movp:catalog:pending:v1"), false);
});

const REMOTE = "movp:catalog:remote:v1";
const PENDING = "movp:catalog:pending:v1";
const headBody = (etag) => (url) => ({ status: 200, bytes: sampleGz, headers: { etag, "content-length": "99" } });

async function downloadAndImport() {
  await handleGateEvent("fetchCatalog", null, {});
  let r;
  do { r = await handleGateEvent("importTick", null, {}); } while (r.state.importing !== false);
}

test("a finished import seeds the job's baseline with the mirror-prefixed signature; same remote = no pending, changed = pending", async () => {
  const { checkRemote } = await import("../src/movp/refresh.js");
  fetchHandler = headBody('"v1"');
  await downloadAndImport();
  assert.equal(store.get(REMOTE), 'raw.githubusercontent.com|"v1"|99');
  await checkRemote();
  assert.equal(store.has(PENDING), false);
  fetchHandler = headBody('"v2"');
  await checkRemote();
  assert.equal(store.has(PENDING), true);
});

test("a failed import does not claim a baseline", async () => {
  fetchHandler = headBody('"v1"');
  await handleGateEvent("fetchCatalog", null, {});
  const orig = globalThis.kino.catalog.upsert;
  globalThis.kino.catalog.upsert = async () => { throw new Error("db"); };
  const r = await handleGateEvent("importTick", null, {});
  globalThis.kino.catalog.upsert = orig;
  assert.equal(r.state.empty, true);
  assert.equal(store.has(REMOTE), false);
});
