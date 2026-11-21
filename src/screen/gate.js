// First-run gate: download the Movie+ catalog, then import it in batches. Three phases, each with its own progress bar:
// idle (a Download button), downloading (indeterminate bar + a tick that fetches) and importing (determinate bar + a
// tick that imports one batch). The screen composes gateView/handleGateEvent with the rich view.

import { catalogCount, isCatalogReady, fetchCatalogText, countItemsText, importTextTick, finishImport } from "../movp/catalog.js";
import { clearRefreshPending, recordRemote, refreshPending, remoteSignature } from "../movp/refresh.js";

const TITLE = "Movie+";
const TICK_MS = 1000;
const IMPORT_BATCH = 500;
// The raw catalog (~9.4 MB) lives in kino.storage (storageLarge: 16 MiB total, 2 MiB per value) between ticks, in pieces.
const CHUNK_CHARS = 400000;
const META_KEY = "movp:gate:meta";
const CHUNK_KEY = "movp:gate:raw:";

export const GATE_EVENTS = new Set(["open", "download", "fetchCatalog", "importTick"]);

const getKino = () => globalThis.kino;

const FAILED_DOWNLOAD = { text: "No se pudo descargar; reintenta", textEn: "Download failed; try again", role: "error" };

/** True while the gate (not the normal screen) must be drawn for `state`. */
export function needsGate(state) {
  const s = state || {};
  return !!(s.downloading || s.importing || !s.ready || s.empty);
}

/** The gate for the current phase; `state.phase` wins, else it is derived from the state flags. */
export function gateView(state) {
  const s = state || {};
  const phase = s.phase
    || (s.downloading ? "downloading" : s.importing ? "importing" : !s.ready ? "loading" : "idle");
  const children = [
    { type: "Text", text: TITLE, style: "h1" },
    { type: "Text", text: "Películas y series para ver cuando quieras.", textEn: "Movies and series to watch whenever you want.", style: "p" },
  ];
  let tick = null;
  if (phase === "loading") {
    children.push({ type: "CircularProgressIndicator", text: "Cargando…", textEn: "Loading…" });
  } else if (phase === "downloading") {
    children.push({ type: "LinearProgressIndicator", labelText: "Descargando catálogo…", labelTextEn: "Downloading catalog…" });
    tick = "fetchCatalog";
  } else if (phase === "importing") {
    const done = Number(s.cursor) || 0;
    const total = Number(s.total) || 0;
    children.push({
      type: "LinearProgressIndicator",
      value: total ? Math.min(1, done / total) : 0,
      labelText: `Importando catálogo… ${done} / ${total}`,
      labelTextEn: `Importing catalog… ${done} / ${total}`,
    });
    tick = "importTick";
  } else {
    children.push({ type: "ElevatedButton", labelText: "Descargar catálogo", labelTextEn: "Download catalog", onPressed: "download" });
  }
  const tree = {
    type: "Scaffold",
    appBar: {
      type: "AppBar", title: TITLE, mergeWithKinoBar: true, dense: true,
      leading: { type: "IconButton", icon: "close", onPressed: "close_screen", labelText: "Cerrar", labelTextEn: "Close" },
    },
    body: { type: "Column", mainAxisAlignment: "center", crossAxisAlignment: "center", padding: 24, gap: 16, children },
  };
  return tick ? { ...tree, every: [{ ms: TICK_MS, event: tick }] } : tree;
}

function readMeta() {
  try {
    const m = JSON.parse(getKino().storage.get(META_KEY) || "null");
    return m && Number.isInteger(m.chunks) && m.chunks > 0 ? m : null;
  } catch (_) {
    return null;
  }
}

function writeMeta(meta) {
  getKino().storage.set(META_KEY, JSON.stringify(meta));
}

function clearRaw() {
  const st = getKino().storage;
  const meta = readMeta();
  if (meta) for (let i = 0; i < meta.chunks; i++) st.remove(CHUNK_KEY + i);
  st.remove(META_KEY);
}

function chunkText(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + CHUNK_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--; // never cut a surrogate pair in two
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

// The RAW catalog text is stored as-is (never JSON.stringify'd — that would recurse over the whole catalog and crash the
// same way the parse did). The streaming cursor lives in the meta and advances a batch per import tick.
function storeRaw(text, total, remote) {
  clearRaw();
  const chunks = chunkText(text);
  try {
    chunks.forEach((c, i) => getKino().storage.set(CHUNK_KEY + i, c));
    writeMeta({ chunks: chunks.length, total, cursor: { si: 0, off: -1, done: 0, recent: null }, remote });
  } catch (err) {
    for (let i = 0; i < chunks.length; i++) getKino().storage.remove(CHUNK_KEY + i);
    throw err;
  }
}

/** The stored raw catalog text (the chunks joined — no JSON.parse), or null if a chunk is missing. */
function loadRaw(meta) {
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) {
    const c = getKino().storage.get(CHUNK_KEY + i);
    if (c == null) return null;
    parts.push(c);
  }
  return parts.join("");
}

async function open() {
  const meta = readMeta();
  if (meta) { // an import was in flight: resume it (the gate ticks importTick)
    const done = (meta.cursor && Number(meta.cursor.done)) || 0;
    return { state: { ready: true, importing: true, cursor: done, total: Number(meta.total) || 0 } };
  }
  if ((await catalogCount()) === 0 || !(await isCatalogReady()) || refreshPending()) return { state: { ready: true, downloading: true } };
  return { state: { ready: true, downloading: false, importing: false, empty: false } };
}

async function fetchStep() {
  try {
    const remote = await remoteSignature();
    const text = await fetchCatalogText();
    const total = countItemsText(text);
    storeRaw(text, total, remote);
    try { getKino().log && getKino().log(`Movie+ download done: ${total} items, ${text.length} chars; starting streamed import`); } catch (_) {}
    return { state: { downloading: false, importing: true, cursor: 0, total } };
  } catch (_) {
    return { state: { downloading: false, ready: true, empty: true }, toast: FAILED_DOWNLOAD };
  }
}

async function importStep() {
  const meta = readMeta();
  const text = meta && loadRaw(meta);
  if (!text) {
    clearRaw();
    if (await isCatalogReady()) return { state: { importing: false, ready: true, empty: false, imported: true } };
    return { state: { importing: false, ready: true, empty: true } };
  }
  try {
    const next = await importTextTick(text, meta.cursor, IMPORT_BATCH);
    const total = Number(meta.total) || next.done;
    try { getKino().log && getKino().log(`Movie+ import tick: ${next.done}/${total}${next.finished ? " (finished)" : ""}`); } catch (_) {}
    if (next.finished) {
      finishImport(next.recent, total);
      clearRaw();
      clearRefreshPending();
      await recordRemote(meta.remote);
      return { state: { importing: false, ready: true, empty: false, imported: true, cursor: total, total } };
    }
    writeMeta({ ...meta, cursor: { si: next.si, off: next.off, done: next.done, recent: next.recent } });
    return { state: { cursor: next.done, total } };
  } catch (_) {
    clearRaw();
    return { state: { importing: false, ready: true, empty: true }, toast: FAILED_DOWNLOAD };
  }
}

/** Handles the gate events (see GATE_EVENTS); resolves to the screenEvent answer, or null for any other event. */
export async function handleGateEvent(name, _value, _state) {
  switch (name) {
    case "open": return open();
    case "download": return { state: { downloading: true } };
    case "fetchCatalog": return fetchStep();
    case "importTick": return importStep();
    default: return null;
  }
}
