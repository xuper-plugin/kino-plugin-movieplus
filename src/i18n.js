// Small central dictionary for the strings built at run time (settings status). Static labels in the manifest and the
// screen trees keep Kino's own label/labelEn and text/textEn pairs.

const DICT = {
  catalogReady: { es: "{n} títulos disponibles", en: "{n} titles available" },
  catalogPending: { es: "{n} títulos; hay una actualización pendiente, se aplica al abrir Movie+", en: "{n} titles; an update is pending, it applies when you open Movie+" },
  catalogEmpty: { es: "Aún no descargado; abre Movie+ para descargarlo", en: "Not downloaded yet; open Movie+ to download it" },
  // Plugin setup (apiVersion 30): the lines Kino shows while it sets Movie+ up, and the sentences of a failed step
  // (kino.error's userMessage; Kino shows only a plain sentence, so no "+" nor URL in those).
  setupRecipe: { es: "Activando Movie+…", en: "Activating Movie+…" },
  setupDownload: { es: "Descargando el catálogo de Movie+…", en: "Downloading the Movie+ catalog…" },
  setupImport: { es: "Importando el catálogo de Movie+…", en: "Importing the Movie+ catalog…" },
  setupNeeds: { es: "Movie+ necesita descargar su catálogo", en: "Movie+ needs to download its catalog" },
  setupImportFailed: { es: "No se pudo importar el catálogo, reintenta", en: "Could not import the catalog, try again" },
  // The vault's refusals while activating (kino.vault.get): what the person can do about each.
  vaultNoTelegram: { es: "Valida tu Telegram en Kino para activar Movie+", en: "Validate your Telegram in Kino to activate Movie+" },
  vaultNotMember: { es: "Movie+ es para los miembros del grupo de Kino", en: "Movie+ is for members of the Kino group" },
  vaultNotFound: { es: "Movie+ no está disponible ahora mismo", en: "Movie+ is not available right now" },
  vaultBusy: { es: "Demasiadas solicitudes a Movie+; intenta en un momento", en: "Too many requests to Movie+; try again in a moment" },
  vaultFailed: { es: "No se pudo activar Movie+, revisa tu conexión y reintenta", en: "Could not activate Movie+, check your connection and try again" },
  setupDownloadFailed: { es: "No se pudo descargar el catálogo, revisa tu conexión y reintenta", en: "Could not download the catalog, check your connection and try again" },
};

/** Kino's language as this dictionary's key: kino.lang is a tag ("es-CO", "en-US"). */
export function kinoLang(kino = globalThis.kino) {
  return String((kino && kino.lang) || "es").slice(0, 2).toLowerCase() === "en" ? "en" : "es";
}

export function t(key, lang = "es", params = {}) {
  const entry = DICT[key];
  if (!entry) return key;
  const text = entry[lang] || entry.es;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
