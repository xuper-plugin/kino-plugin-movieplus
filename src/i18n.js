// Small central dictionary for the strings built at run time (settings status). Static labels in the manifest and the
// screen trees keep Kino's own label/labelEn and text/textEn pairs.

const DICT = {
  catalogReady: { es: "{n} títulos disponibles", en: "{n} titles available" },
  catalogPending: { es: "{n} títulos; hay una actualización pendiente, se aplica al abrir Movie+", en: "{n} titles; an update is pending, it applies when you open Movie+" },
  catalogEmpty: { es: "Aún no descargado; abre Movie+ para descargarlo", en: "Not downloaded yet; open Movie+ to download it" },
};

export function t(key, lang = "es", params = {}) {
  const entry = DICT[key];
  if (!entry) return key;
  const text = entry[lang] || entry.es;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
