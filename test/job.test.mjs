import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const rows = new Map();
let headHandler = () => ({ status: 200, headers: { etag: '"v1"', "content-length": "100" } });
const calls = [];

globalThis.kino = {
  lang: "es",
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, String(v)); },
    remove: (k) => { store.delete(k); },
  },
  catalog: { async count() { return rows.size; } },
  async fetch(url, opts = {}) {
    calls.push({ url, method: opts.method });
    const { status = 200, headers = {} } = await headHandler(url);
    return { ok: status >= 200 && status < 300, status, url, headers };
  },
};

const { job, settingsStatus } = await import("../src/plugin.js");
const { refreshPending, clearRefreshPending } = await import("../src/movp/refresh.js");

beforeEach(() => {
  store.clear();
  rows.clear();
  calls.length = 0;
  headHandler = () => ({ status: 200, headers: { etag: '"v1"', "content-length": "100" } });
});

test("first run only records the mirror signature", async () => {
  await job();
  assert.equal(refreshPending(), false);
  assert.equal(calls[0].method, "HEAD");
  assert.equal(calls.length, 1);
});

test("an unchanged file leaves nothing pending", async () => {
  await job();
  await job();
  assert.equal(refreshPending(), false);
});

test("a changed file flags a pending update that clearRefreshPending drops", async () => {
  await job();
  headHandler = () => ({ status: 200, headers: { etag: '"v2"', "content-length": "120" } });
  await job();
  assert.equal(refreshPending(), true);
  clearRefreshPending();
  assert.equal(refreshPending(), false);
});

test("a mirror answering in place of another never fabricates a diff, only moves the baseline", async () => {
  await job();
  const ids = { etag: '"v1"', "content-length": "100" };
  headHandler = (url) => { if (url.includes("raw.githubusercontent")) throw new Error("offline"); return { status: 200, headers: ids }; };
  await job();
  assert.equal(refreshPending(), false);
  assert.match(store.get("movp:catalog:remote:v1"), /^appsdevxp\.com\|/);
});

test("a genuine content change on the same host sets pending, even after falling through failing mirrors", async () => {
  headHandler = (url) => { if (url.includes("raw.githubusercontent")) throw new Error("offline"); return { status: 200, headers: { etag: '"a"' } }; };
  await job();
  headHandler = (url) => { if (url.includes("raw.githubusercontent")) throw new Error("offline"); return { status: 200, headers: { etag: '"b"' } }; };
  await job();
  assert.equal(refreshPending(), true);
});

test("never throws when every mirror fails and leaves the flag alone", async () => {
  await job();
  headHandler = () => { throw new Error("offline"); };
  await assert.doesNotReject(job());
  assert.equal(refreshPending(), false);
  assert.equal(calls.filter((c) => c.method === "HEAD").length, 4);
});

test("settingsStatus reports the catalog state in the person's language", async () => {
  assert.match((await settingsStatus()).catalogStatus, /^Aún no descargado/);
  rows.set("m:1", {});
  assert.equal((await settingsStatus()).catalogStatus, "1 títulos disponibles");
  store.set("movp:catalog:pending:v1", "1");
  assert.match((await settingsStatus()).catalogStatus, /actualización pendiente/);
  globalThis.kino.lang = "en";
  assert.match((await settingsStatus()).catalogStatus, /update is pending/);
  globalThis.kino.lang = "es";
});

test("settingsStatus reports a ready catalog with its size in es and en", async () => {
  rows.set("m:1", {});
  rows.set("m:2", {});
  assert.equal((await settingsStatus()).catalogStatus, "2 títulos disponibles");
  globalThis.kino.lang = "en";
  try {
    assert.equal((await settingsStatus()).catalogStatus, "2 titles available");
  } finally {
    globalThis.kino.lang = "es";
  }
});

test("settingsStatus never throws and falls back to the not-downloaded text when an underlying call fails", async () => {
  const realCount = globalThis.kino.catalog.count;
  const realGet = globalThis.kino.storage.get;
  try {
    globalThis.kino.catalog.count = async () => { throw new Error("catalog unavailable"); };
    assert.match((await settingsStatus()).catalogStatus, /^Aún no descargado/);
    globalThis.kino.catalog.count = realCount;
    rows.set("m:1", {});
    globalThis.kino.storage.get = () => { throw new Error("storage unavailable"); };
    assert.match((await settingsStatus()).catalogStatus, /^Aún no descargado/);
    globalThis.kino.lang = "en";
    assert.match((await settingsStatus()).catalogStatus, /^Not downloaded yet/);
  } finally {
    globalThis.kino.catalog.count = realCount;
    globalThis.kino.storage.get = realGet;
    globalThis.kino.lang = "es";
  }
});
