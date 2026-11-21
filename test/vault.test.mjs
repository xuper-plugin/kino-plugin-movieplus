import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const RECIPE = {
  apiBase: "https://api.appsxploit.dev", appVersion: "17.4", versionCode: 90355, channel: "prod",
  settingsProfile: 7, reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
};

let store, vaultCalls, vaultAnswer;
class KinoError extends Error { constructor(code, message) { super(message); this.code = code; } }

globalThis.kino = {
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  },
  error: (code, message) => new KinoError(code, message),
  // kino.vault.get() (apiVersion 28): Kino does the whole exchange; the plugin just asks. The test answers it (or throws a code).
  vault: {
    get: async () => {
      vaultCalls++;
      if (vaultAnswer instanceof Error) throw vaultAnswer;
      return vaultAnswer;
    },
  },
};

const { ensureRecipe, recipe, hasRecipe, clearRecipe } = await import("../src/movp/vault.js");

beforeEach(() => {
  store = new Map();
  vaultCalls = 0;
  vaultAnswer = RECIPE;
});

test("recipe() throws recipe_unavailable when nothing is cached (no hardcoded fallback)", () => {
  assert.equal(hasRecipe(), false);
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("ensureRecipe: kino.vault.get() → caches and returns the recipe", async () => {
  const got = await ensureRecipe();
  assert.deepEqual(got, RECIPE);
  assert.deepEqual(recipe(), RECIPE);
  assert.equal(hasRecipe(), true);
  assert.equal(vaultCalls, 1, "asked the vault exactly once");
});

test("ensureRecipe: a cached fresh recipe short-circuits with no vault call", async () => {
  await ensureRecipe();
  vaultCalls = 0;
  const again = await ensureRecipe();
  assert.deepEqual(again, RECIPE);
  assert.equal(vaultCalls, 0, "no kino.vault.get when cached");
});

test("ensureRecipe: not_member → not_member, nothing cached (anti-copy: a non-member / re-signed copy gets no recipe)", async () => {
  vaultAnswer = new KinoError("not_member", "no");
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "not_member");
  assert.equal(hasRecipe(), false);
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("ensureRecipe: rate_limited → rate_limited, nothing cached", async () => {
  vaultAnswer = new KinoError("rate_limited", "slow down");
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "rate_limited");
  assert.equal(hasRecipe(), false);
});

test("ensureRecipe: not_found and any other code map to unavailable", async () => {
  vaultAnswer = new KinoError("not_found", "no secret");
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "unavailable");
  vaultAnswer = new KinoError("whatever", "boom");
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "unavailable");
  assert.equal(hasRecipe(), false);
});

test("an invalid recipe from the vault is rejected (not cached)", async () => {
  vaultAnswer = { apiBase: "https://x", appVersion: "1" }; // missing required fields
  await assert.rejects(() => ensureRecipe(), (e) => e.code === "unavailable");
  assert.equal(hasRecipe(), false);
});

test("ensureRecipe: no kino.vault binding (too-old Kino) → unavailable", async () => {
  const saved = globalThis.kino.vault;
  globalThis.kino.vault = undefined;
  try {
    await assert.rejects(() => ensureRecipe(), (e) => e.code === "unavailable");
  } finally {
    globalThis.kino.vault = saved;
  }
});

test("recipe cache expires after the TTL (~1h), forcing a re-mint", async () => {
  await ensureRecipe();
  const raw = JSON.parse(store.get("movp:recipe:v1"));
  raw.at = Date.now() - (61 * 60 * 1000);
  store.set("movp:recipe:v1", JSON.stringify(raw));
  assert.equal(hasRecipe(), false, "stale cache is ignored");
  assert.throws(() => recipe(), (e) => e.code === "recipe_unavailable");
});

test("clearRecipe drops the cache", async () => {
  await ensureRecipe();
  assert.equal(hasRecipe(), true);
  clearRecipe();
  assert.equal(hasRecipe(), false);
});
