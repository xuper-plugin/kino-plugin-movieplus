// The vault's refusals while activating Movie+ reach the person (Kino's setup sheet shows userMessage), in their language.
import test from "node:test";
import assert from "node:assert/strict";

function fakeKino(code, lang = "es-CO") {
  const store = new Map();
  return {
    lang,
    log() {},
    storage: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) },
    error(c, message, opts = {}) { const e = new Error(message); e.code = c; if (opts.userMessage) e.userMessage = opts.userMessage; return e; },
    vault: { async get() { const e = new Error("refused"); e.code = code; throw e; } },
  };
}

for (const [code, es, en] of [
  ["not_available", /Valida tu Telegram en Kino/, /Validate your Telegram in Kino/],
  ["not_member", /miembros del grupo de Kino/, /members of the Kino group/],
  ["timeout", /No se pudo activar Movie\+/, /Could not activate Movie\+/],
]) {
  test(`kino.vault ${code}: a sentence for the person, Spanish and English`, async () => {
    for (const [lang, want] of [["es-CO", es], ["en-US", en]]) {
      globalThis.kino = fakeKino(code, lang);
      const { ensureRecipe } = await import(`../src/movp/vault.js?${code}-${lang}`);
      await assert.rejects(ensureRecipe(), (e) => want.test(e.userMessage || ""));
    }
  });
}

test("the screen's access gate shows the vault's reason (no Telegram) instead of the generic line", async () => {
  globalThis.kino = fakeKino("not_available", "es-CO");
  const { screen, screenEvent } = await import("../src/plugin.js?gate-why");
  const a = await screenEvent({ name: "open", state: {} });
  assert.equal(a.state.verifyFailed, true);
  assert.match(a.state.verifyWhy, /Valida tu Telegram en Kino/);
  const text = JSON.stringify(await screen({ state: a.state }));
  assert.match(text, /Valida tu Telegram en Kino/);
  assert.doesNotMatch(text, /No se pudo verificar tu acceso/);
});
