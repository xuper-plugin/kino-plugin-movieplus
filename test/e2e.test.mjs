// End-to-end through the Kino kit's own runtime (sdk/kino-shim.mjs): the built plugin.js downloads the fixture catalog
// through the gate, imports it, then answers search and draws the branded screen. The kit keeps kino.catalog in memory per
// process, so a single `node sdk/run.mjs . search halo` always starts empty; this test seeds it the way the app would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createKino } from "../sdk/kino-shim.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("kino-plugin.json", root), "utf8"));
const gz = readFileSync(new URL("test/fixtures/items-sample.json.gz", root));

const fetchImpl = async (url, init = {}) => {
  if (String(url).includes("items-light.json.gz")) {
    return new Response(init.method === "HEAD" ? null : gz, { status: 200, headers: { etag: '"e2e"', "content-length": String(gz.length) } });
  }
  return new Response("not found", { status: 404 });
};

const { kino } = createKino(manifest, { fetchImpl, config: {}, env: {} });
globalThis.kino = kino;
// A cached vault recipe so the "verify" step short-circuits (the shim's fetch does not mock the vault) and `open` runs
// the catalog gate end to end.
kino.storage.set("movp:recipe:v1", JSON.stringify({ at: Date.now(), recipe: {
  apiBase: "https://movp.backend", appVersion: "1", versionCode: 1, channel: "c", settingsProfile: 1, reqPrefix: "RQ", sessionPrefix: "SS",
} }));
const plugin = await import("../plugin.js");

const find = (node, pred, out = []) => {
  if (node && typeof node === "object") {
    if (pred(node)) out.push(node);
    for (const v of Object.values(node)) find(v, pred, out);
  }
  return out;
};

test("gate downloads and imports, then search finds Halo and the screen draws the bar", async () => {
  let state = {};
  const step = async (name) => {
    const a = await plugin.screenEvent({ name, state, device: "phone", lang: "es" });
    state = { ...state, ...(a.state || {}) };
    return a;
  };
  await step("open");
  assert.equal(state.downloading, true);
  await step("fetchCatalog");
  assert.equal(state.importing, true);
  for (let i = 0; i < 50 && state.importing; i++) await step("importTick");
  assert.equal(state.importing, false);
  assert.ok(state.ready && !state.empty);

  const found = await plugin.search("halo");
  assert.ok(found.some((it) => /^halo$/i.test(it.title)), "Halo series is returned");

  const tree = await plugin.screen({ state, device: "phone", lang: "es" });
  assert.ok(find(tree, (n) => n.type === "TabBar" || n.onPressed === "tab" || n.onPressed === "open_search").length > 0, "the top bar is drawn");
});

test("the scheduled job and the catalog status work after an import", async () => {
  await assert.doesNotReject(plugin.job());
  assert.match((await plugin.settingsStatus()).catalogStatus, /títulos disponibles|titles available/);
});
