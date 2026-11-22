// Movie+: films and series from the Movie+ catalog. The catalog contract lives in contract/, the scheduled refresh
// check in movp/refresh.js; section is still a stub.

export { home, search, browse, details, episodes, resolve } from "./contract/index.js";
export { screen, screenEvent } from "./screen/index.js";
export { setupStatus, setupRun } from "./setup.js";

import { catalogCount } from "./movp/catalog.js";
import { catalogStatusText, checkRemote } from "./movp/refresh.js";

export async function section() {
  return { items: [] };
}

export async function job() {
  return checkRemote();
}

export async function settingsStatus() {
  const lang = globalThis.kino.lang === "en" ? "en" : "es";
  try {
    return { catalogStatus: catalogStatusText(await catalogCount(), lang) };
  } catch (_) {
    return { catalogStatus: catalogStatusText(0, lang) };
  }
}
