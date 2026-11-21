import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/i18n.js";

test("t resolves es and en, defaulting to es", () => {
  assert.equal(t("catalogReady", "es", { n: 5 }), "5 títulos disponibles");
  assert.equal(t("catalogReady", "en", { n: 5 }), "5 titles available");
  assert.equal(t("catalogEmpty"), "Aún no descargado; abre Movie+ para descargarlo");
  assert.match(t("catalogPending", "en", { n: 2 }), /^2 titles; an update is pending/);
});

test("t falls back to es for an unknown language and echoes an unknown key", () => {
  assert.match(t("catalogEmpty", "fr"), /^Aún no/);
  assert.equal(t("nope"), "nope");
});
