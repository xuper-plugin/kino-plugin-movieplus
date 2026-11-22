// Plugin setup (apiVersion 30): Kino asks setupStatus() cheaply (also at app start, UNATTENDED — so no vault / identity here)
// and drives setupRun() step by step, person-started, until done. Setup = the recipe (kino.vault.get, via ensureRecipe) and
// then the catalog (the gate's download + one streamed batch per call). All of it reuses the gate screen's functions; the
// cursor lives in kino.storage, so a call after a restart resumes. Never a full JSON.parse of the catalog (QuickJS SIGSEGV).

import { t, kinoLang } from "./i18n.js";
import { isCatalogReady } from "./movp/catalog.js";
import { ensureRecipe, hasRecipe, recipeSeen } from "./movp/vault.js";
import { handleGateEvent, importProgress } from "./screen/gate.js";

const getKino = () => globalThis.kino;

/** One of the setup's lines in Kino's language (src/i18n.js). */
const L = (key) => t(key, kinoLang(getKino()));

const clamp = (x) => Math.max(0, Math.min(1, x));

/** Ready = this install got its recipe at least once AND the catalog is imported. Cheap; reads only kino.storage / kino.catalog. */
export async function setupStatus() {
  if (!recipeSeen()) return { ready: false, label: L("setupNeeds"), progress: 0 };
  if (await isCatalogReady()) return { ready: true };
  const p = importProgress();
  return { ready: false, label: L(p ? "setupImport" : "setupNeeds"), progress: p && p.total ? clamp(p.done / p.total) : 0 };
}

/** A failed step: Kino shows [sentenceKey]'s sentence (in the person's language) as the setup's line. */
function stepError(code, message, sentenceKey) {
  return getKino().error(code, message, { userMessage: L(sentenceKey) });
}

/** One bounded chunk of the setup; Kino calls it again (step + 1) until `done`. */
export async function setupRun(_args) {
  // Step: the recipe (the vault answers here because the person started this). A refusal throws its own labelled error.
  if (!hasRecipe()) {
    await ensureRecipe();
    return { done: false, progress: 0.02, label: L("setupRecipe") };
  }
  const opened = await handleGateEvent("open", null, {});
  const st = (opened && opened.state) || {};
  if (st.importing) {
    const r = await handleGateEvent("importTick", null, {});
    const s = (r && r.state) || {};
    if (s.empty) throw stepError("unavailable", "No se pudo importar el catálogo de Movie+. Reintenta.", "setupImportFailed");
    if (s.importing === false) return { done: true, progress: 1 };
    const total = Number(s.total) || 0;
    return { done: false, progress: total ? 0.1 + 0.9 * clamp((Number(s.cursor) || 0) / total) : 0.1, label: L("setupImport") };
  }
  if (st.downloading) {
    const r = await handleGateEvent("fetchCatalog", null, {});
    const s = (r && r.state) || {};
    if (s.empty) throw stepError("unavailable", "No se pudo descargar el catálogo de Movie+. Revisa tu conexión y reintenta.", "setupDownloadFailed");
    return { done: false, progress: 0.1, label: L("setupDownload") };
  }
  return { done: true, progress: 1 };
}
