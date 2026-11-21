import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const RECIPE = {
  apiBase: "https://api.appsxploit.dev", appVersion: "17.4", versionCode: 90355, channel: "prod",
  settingsProfile: 7, reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
};

let store, fetchCalls, routes, identityAnswer;
class KinoError extends Error { constructor(code, message) { super(message); this.code = code; } }

globalThis.kino = {
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  },
  error: (code, message) => new KinoError(code, message),
  identity: { telegram: async (opts) => { fetchCalls.push({ identity: opts }); return identityAnswer; } },
  async fetch(url, opts = {}) {
    fetchCalls.push({ url, body: opts.body });
    const r = routes(url, opts) || { status: 404, body: "" };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: () => JSON.parse(text), text: () => text };
  },
};

const { ensureRecipe, recipe, hasRecipe, clearRecipe } = await import("../src/movp/vault.js");

const okRoutes = (url) => {
  if (url.endsWith("/session/challenge")) return { status: 200, body: { challenge: "c".repeat(20), expiresAt: Date.now() + 60000 } };
  if (url.includes("/secrets/")) return { status: 200, body: { secret: RECIPE } };
  return null;
};

beforeEach(() => {
  store = new Map();
  fetchCalls = [];
  routes = okRoutes;
  identityAnswer = { id: "p".repeat(32), deviceKey: "dk", signature: "sig", author: "E04E-EA25-1A34-290E", codeHash: "c0de" };
});

test("recipe() throws recipe_unavailable when nothing is cached (no hardcoded fallback)", () => {
  assert.equal(hasRecipe(), false);
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("ensureRecipe: challenge → kino.identity → POST /secrets → caches and returns the recipe", async () => {
  const got = await ensureRecipe();
  assert.deepEqual(got, RECIPE);
  assert.deepEqual(recipe(), RECIPE);
  assert.equal(hasRecipe(), true);
  // the challenge was fetched, identity signed it, and the /secrets body carries the signed fields
  const secretCall = fetchCalls.find((c) => c.url && c.url.includes("/secrets/xuper-plugin/kino-plugin-movieplus"));
  assert.ok(secretCall, "posts to /secrets/{owner}/{repo}");
  const body = JSON.parse(secretCall.body);
  assert.equal(body.pluginId, "movieplus");
  assert.equal(body.author, "E04E-EA25-1A34-290E");
  assert.equal(body.id, "p".repeat(32));
  assert.ok(body.challenge && body.deviceKey && body.signature);
});

test("ensureRecipe: sends the gate `token` when kino.identity returns one (token-author live-membership path)", async () => {
  identityAnswer = { id: "p".repeat(32), deviceKey: "dk", signature: "sig", author: "E04E-EA25-1A34-290E", codeHash: "c0de", token: "GATE.TOKEN.SIG" };
  await ensureRecipe();
  const secretCall = fetchCalls.find((c) => c.url && c.url.includes("/secrets/"));
  const body = JSON.parse(secretCall.body);
  assert.equal(body.token, "GATE.TOKEN.SIG", "the raw gate token is forwarded to the vault");
  assert.equal(body.id, "p".repeat(32), "and the pseudonym still goes too (binding + fallback)");
});

test("ensureRecipe: omits `token` when kino.identity returns none (universal path unchanged)", async () => {
  // default identityAnswer has no token
  await ensureRecipe();
  const secretCall = fetchCalls.find((c) => c.url && c.url.includes("/secrets/"));
  const body = JSON.parse(secretCall.body);
  assert.ok(!("token" in body), "no token field when there is no token");
});

test("ensureRecipe: a cached fresh recipe short-circuits with no network", async () => {
  await ensureRecipe();
  fetchCalls = [];
  const again = await ensureRecipe();
  assert.deepEqual(again, RECIPE);
  assert.equal(fetchCalls.length, 0, "no challenge, no identity, no /secrets when cached");
});

test("ensureRecipe: 403 → not_member, nothing cached (anti-copy: a non-member / re-signed copy gets no recipe)", async () => {
  routes = (url) => (url.endsWith("/session/challenge")
    ? { status: 200, body: { challenge: "c".repeat(20) } }
    : url.includes("/secrets/") ? { status: 403, body: { error: "not_member" } } : null);
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "not_member");
  assert.equal(hasRecipe(), false);
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("ensureRecipe: 429 → rate_limited, nothing cached", async () => {
  routes = (url) => (url.endsWith("/session/challenge")
    ? { status: 200, body: { challenge: "c".repeat(20) } }
    : { status: 429, body: {} });
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "rate_limited");
  assert.equal(hasRecipe(), false);
});

test("recipe cache expires after the TTL (~1h), forcing a re-mint", async () => {
  await ensureRecipe();
  // age the stored timestamp past the TTL
  const raw = JSON.parse(store.get("movp:recipe:v1"));
  raw.at = Date.now() - (61 * 60 * 1000);
  store.set("movp:recipe:v1", JSON.stringify(raw));
  assert.equal(hasRecipe(), false, "stale cache is ignored");
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("an invalid recipe from the vault is rejected (not cached)", async () => {
  routes = (url) => (url.endsWith("/session/challenge")
    ? { status: 200, body: { challenge: "c".repeat(20) } }
    : { status: 200, body: { secret: { apiBase: "https://x", appVersion: "1" } } }); // missing required fields
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "unavailable");
  assert.equal(hasRecipe(), false);
});

test("clearRecipe drops the cache", async () => {
  await ensureRecipe();
  assert.equal(hasRecipe(), true);
  clearRecipe();
  assert.equal(hasRecipe(), false);
});
