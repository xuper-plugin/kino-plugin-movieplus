// Movie+ catalog: one gzip JSON (~25k titles) downloaded once and indexed, in resumable batches, into kino.catalog.
// kino.fetch / kino.catalog / kino.storage / kino.crypto are read from globalThis.kino at call time, so the module also
// runs under node --test with a shim.

import { gunzipBase64ToText } from "./inflate.js";
import { arrayStart, scanElements, countArray } from "./stream.js";

export const CATALOG_URLS = [
  "https://raw.githubusercontent.com/dev-mplus01/mplus01T/main/db/items.json.gz",
  "https://appsdevxp.com/app/db/items.json.gz",
  "https://developerxploit.com/app/db/items.json.gz",
];
const FETCH_TIMEOUT_MS = 30000;
const UPSERT_MAX = 500;
const RECENT_PER_CATEGORY = 200;
const SCAN_PAGE = 100;
const SCAN_MAX_PAGES = 30;
const BROWSE_SCAN_PAGES = 10;
const TITLE_MAX = 300;
const CURSOR_KEY = "movp:catalog:cursor:v1";
const DONE_KEY = "movp:catalog:v1";
const RECENT_KEY = "movp:catalog:recent:v1";

export const CATEGORIES = [
  { key: "peliculas", label: "Películas", labelEn: "Movies", types: [1] },
  { key: "series", label: "Series", labelEn: "Series", types: [2] },
  { key: "animes", label: "Animes-Cartoons", labelEn: "Anime & Cartoons", types: [3, 4] },
  { key: "doramas", label: "Doramas", labelEn: "Doramas", types: [6] },
  { key: "duanju", label: "Duanju", labelEn: "Duanju", types: [7] },
  { key: "telenovelas", label: "Telenovelas", labelEn: "Telenovelas", types: [5] },
];

const getKino = () => globalThis.kino;

export function typeToCategory(type) {
  const t = Number(type);
  const cat = CATEGORIES.find((c) => c.types.includes(t));
  return cat ? cat.key : null;
}

// kino.crypto.gunzip refuses output over 5 MB and this catalog unzips to ~10 MB: fall back to a JS inflate.
function gunzipText(b64) {
  const k = getKino();
  if (k.crypto && typeof k.crypto.gunzip === "function") {
    try {
      const out = k.crypto.gunzip(b64);
      try { k.log && k.log(`native gunzip ok: ${out.length} chars`); } catch (_) {}
      return out;
    } catch (e) {
      try { k.log && k.log(`native gunzip failed (${(e && (e.message || e.code)) || e}); using JS inflate`); } catch (_) {}
    }
  }
  const t0 = Date.now();
  const out = gunzipBase64ToText(b64);
  try { k.log && k.log(`JS inflate ok: ${out.length} chars in ${Date.now() - t0} ms`); } catch (_) {}
  return out;
}

/**
 * The raw catalog TEXT from the first working mirror (downloaded + gunzipped, lightly validated). It is NEVER
 * JSON.parse'd whole: QuickJS's JSON.parse recurses once per array element, so the ~25k-item catalog overflows the
 * plugin thread's native stack and SIGSEGVs the whole app. The gate stores this text and imports it in streamed batches
 * (importTextTick), so no single parse ever runs over the full catalog.
 */
export async function fetchCatalogText() {
  const k = getKino();
  let lastErr = null;
  for (const url of CATALOG_URLS) {
    try {
      const resp = await k.fetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = gunzipText(resp.base64());
      if (arrayStart(text, "movies") < 0 && arrayStart(text, "series") < 0) throw new Error("unexpected catalog shape");
      try { k.log && k.log(`Movie+ catalog text ready from ${url}: ${text.length} chars`); } catch (_) {}
      return text;
    } catch (err) {
      lastErr = err;
      try { k.log && k.log(`catalog mirror failed ${url}: ${(err && (err.message || err.code)) || err}`); } catch (_) {}
    }
  }
  throw k.error("unavailable", `Movie+ catalog download failed${lastErr && lastErr.message ? ": " + lastErr.message : ""}`);
}

/**
 * The whole catalog as `{movies, series}`. Parses the full text in one go, so it is for SMALL catalogs only (the tests,
 * and callers that know the size is bounded); the first-run gate uses fetchCatalogText + importTextTick instead.
 */
export async function fetchCatalog() {
  const k = getKino();
  let cat;
  try { cat = JSON.parse(await fetchCatalogText()); } catch (err) {
    if (err && err.code === "unavailable") throw err;
    throw k.error("unavailable", `Movie+ catalog download failed: ${(err && (err.message || err.code)) || err}`);
  }
  if (!cat || (!Array.isArray(cat.movies) && !Array.isArray(cat.series))) throw k.error("unavailable", "unexpected catalog shape");
  return { movies: cat.movies || [], series: cat.series || [] };
}

/** The item count of the raw catalog text (movies + series), by a cheap scan (no JSON.parse). */
export function countItemsText(text) {
  return countArray(text, "movies") + countArray(text, "series");
}

const STREAM_SPECS = [
  { key: "movies", kind: "movie", type: 1 },
  { key: "series", kind: "series", type: 2 },
];

/** Keep the highest-`s` items: insert into the bounded list, dropping the current minimum when full. */
function insertTopN(list, item, n) {
  if (list.length < n) { list.push(item); return; }
  let mi = 0;
  for (let i = 1; i < list.length; i++) if (list[i].s < list[mi].s) mi = i;
  if (item.s > list[mi].s) list[mi] = item;
}

/**
 * Import ONE batch of the raw catalog `text` into kino.catalog, streaming — each element is a small JSON snippet parsed
 * on its own, so the parser never recurses over the whole catalog. `cursor` is serializable and kept between ticks:
 *   { si: STREAM_SPECS index, off: text offset (<0 = that array not started), done: items imported, recent: {catKey:[{id,s}]} }
 * @returns {Promise<{si:number, off:number, done:number, recent:object, finished:boolean}>}
 */
export async function importTextTick(text, cursor, batch) {
  const k = getKino();
  const max = Math.max(1, Math.min(UPSERT_MAX, Math.floor(Number(batch)) || UPSERT_MAX));
  let si = cursor && Number.isInteger(cursor.si) ? cursor.si : 0;
  let off = cursor && Number.isInteger(cursor.off) ? cursor.off : -1;
  let done = (cursor && Number(cursor.done)) || 0;
  let recent = cursor && cursor.recent;
  if (!recent) { recent = {}; for (const c of CATEGORIES) recent[c.key] = []; }

  // Skip specs whose array is absent (or already finished), landing `off` at the next array's first element.
  while (si < STREAM_SPECS.length && off < 0) {
    off = arrayStart(text, STREAM_SPECS[si].key);
    if (off < 0) si++;
  }
  if (si >= STREAM_SPECS.length) return { si, off: -1, done, recent, finished: true };

  const spec = STREAM_SPECS[si];
  const { elems, next, done: arrDone } = scanElements(text, off, max);
  const rows = [];
  let failed = 0;
  for (const e of elems) {
    let raw;
    try { raw = JSON.parse(e); } catch (_) { failed++; continue; }
    if (!raw || raw.id == null) continue;
    const item = toItem(raw, spec.kind, spec.type);
    const stored = toStored(item, new Map([[item.id, raw.date]]));
    rows.push(stored);
    const list = recent[item.categoryKey];
    if (list) insertTopN(list, { id: item.id, s: stored.sort }, RECENT_PER_CATEGORY);
  }
  if (rows.length) await k.catalog.upsert(rows);
  done += elems.length;
  if (failed) { try { k.log && k.log(`Movie+ import: ${failed} of ${elems.length} ${spec.key} items failed to parse at offset ${off}`); } catch (_) {} }

  if (arrDone) {
    const nextSi = si + 1;
    return { si: nextSi, off: -1, done, recent, finished: nextSi >= STREAM_SPECS.length };
  }
  return { si, off: next, done, recent, finished: false };
}

/** Finish a streamed import: write the recent-by-category lists (from the cursor's `recent`) and the done marker. */
export function finishImport(recent, total) {
  const lists = {};
  for (const c of CATEGORIES) {
    const arr = (recent && recent[c.key]) || [];
    lists[c.key] = arr.slice().sort((a, b) => b.s - a.s).map((x) => x.id);
  }
  writeJson(RECENT_KEY, lists);
  writeJson(DONE_KEY, { at: Date.now(), total: Number(total) || 0 });
  getKino().storage.remove(CURSOR_KEY);
}

function yearOf(date) {
  const y = String(date || "").slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "";
}

function genresOf(raw) {
  return String(raw || "").split(",").map((g) => g.trim()).filter(Boolean);
}

function toItem(raw, kind, defaultType) {
  const type = Number(raw.type) || defaultType;
  return {
    id: (kind === "movie" ? "m:" : "s:") + raw.id,
    kind,
    type,
    title: String(raw.nameFile || ""),
    year: yearOf(raw.date),
    poster: String(raw.urlImage || ""),
    genres: genresOf(raw.generos),
    categoryKey: typeToCategory(type),
  };
}

export function toCatalogItems(cat) {
  const out = [];
  for (const m of (cat && cat.movies) || []) if (m && m.id != null) out.push(toItem(m, "movie", 1));
  for (const s of (cat && cat.series) || []) if (s && s.id != null) out.push(toItem(s, "series", 2));
  return out;
}

function sortOf(item, dates) {
  const t = Date.parse(dates.get(item.id) || "");
  return Number.isSafeInteger(t) ? t : 0;
}

function toStored(item, dates) {
  const title = (item.title || `Movie+ ${item.id}`).slice(0, TITLE_MAX).replace(/[\uD800-\uDBFF]$/, "");
  return {
    id: item.id,
    title,
    sort: sortOf(item, dates),
    data: { k: item.kind, t: item.type, y: item.year, p: item.poster, g: item.genres.join(",") },
  };
}

function fromStored(row) {
  const d = row.data || {};
  const type = Number(d.t) || (d.k === "movie" ? 1 : 2);
  return {
    id: row.id,
    kind: d.k === "movie" ? "movie" : "series",
    type,
    title: row.title,
    year: d.y || "",
    poster: d.p || "",
    genres: genresOf(d.g),
    categoryKey: typeToCategory(type),
  };
}

function readJson(key) {
  try {
    return JSON.parse(getKino().storage.get(key) || "null");
  } catch (_) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    getKino().storage.set(key, JSON.stringify(value));
  } catch (_) { /* storage full: the lists are rebuilt from kino.catalog on demand */ }
}

function dateIndex(cat) {
  const dates = new Map();
  for (const m of (cat && cat.movies) || []) if (m && m.id != null) dates.set("m:" + m.id, m.date);
  for (const s of (cat && cat.series) || []) if (s && s.id != null) dates.set("s:" + s.id, s.date);
  return dates;
}

function signatureOf(items) {
  const first = items.length ? items[0].id : "";
  const last = items.length ? items[items.length - 1].id : "";
  return `${items.length}:${first}:${last}`;
}

/**
 * Import `cat` into kino.catalog, one batch per call, advancing a cursor kept in kino.storage; a later call (even in a
 * new session, with a freshly downloaded copy) continues from it. A catalog with a different signature restarts at 0.
 * When the last batch lands it stores the newest ids of each category and clears the cursor.
 * @returns {Promise<{done:boolean,cursor:number,total:number}>}
 */
export async function importCatalog(cat, opts = {}) {
  const k = getKino();
  const batch = Math.max(1, Math.min(UPSERT_MAX, Math.floor(Number(opts.batch)) || UPSERT_MAX));
  const items = toCatalogItems(cat);
  const total = items.length;
  const sig = signatureOf(items);

  let cursor = 0;
  if (Number.isInteger(opts.cursor) && opts.cursor >= 0) {
    cursor = opts.cursor;
  } else {
    const saved = readJson(CURSOR_KEY);
    if (saved && saved.sig === sig && Number.isInteger(saved.cursor)) cursor = saved.cursor;
  }
  if (cursor > total) cursor = 0;

  const dates = dateIndex(cat);
  const end = Math.min(cursor + batch, total);
  if (cursor < end) {
    await k.catalog.upsert(items.slice(cursor, end).map((it) => toStored(it, dates)));
    cursor = end;
    writeJson(CURSOR_KEY, { cursor, sig });
  }
  if (cursor >= total) {
    writeJson(RECENT_KEY, recentLists(items, dates));
    writeJson(DONE_KEY, { at: Date.now(), total });
    k.storage.remove(CURSOR_KEY);
    return { done: true, cursor: total, total };
  }
  return { done: false, cursor, total };
}

function recentLists(items, dates) {
  const lists = {};
  for (const c of CATEGORIES) lists[c.key] = [];
  const ranked = items
    .map((it, i) => ({ it, i, s: sortOf(it, dates) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  for (const { it } of ranked) {
    const list = lists[it.categoryKey];
    if (list && list.length < RECENT_PER_CATEGORY) list.push(it.id);
  }
  return lists;
}

async function getAll(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += UPSERT_MAX) out.push(...(await getKino().catalog.get(ids.slice(i, i + UPSERT_MAX))));
  return out;
}

/** The newest `limit` items of a category; from the lists saved at the end of the import, else by scanning kino.catalog. */
export async function recentByCategory(categoryKey, limit = 30) {
  const n = Math.max(0, Math.floor(Number(limit)) || 0);
  const lists = readJson(RECENT_KEY);
  if (lists && Array.isArray(lists[categoryKey])) {
    return (await getAll(lists[categoryKey].slice(0, n))).map(fromStored);
  }
  const out = [];
  for (let page = 0; page < SCAN_MAX_PAGES && out.length < n; page++) {
    const res = await getKino().catalog.search({ limit: SCAN_PAGE, offset: page * SCAN_PAGE, order: "newest" });
    for (const row of res.items) {
      const item = fromStored(row);
      if (item.categoryKey === categoryKey && out.length < n) out.push(item);
    }
    if ((page + 1) * SCAN_PAGE >= res.total) break;
  }
  return out;
}

export async function catalogCount() {
  return getKino().catalog.count();
}

/** True only once a full import has finished: done-marker present, no cursor pending and kino.catalog not empty. */
export async function isCatalogReady() {
  const k = getKino();
  if (!readJson(DONE_KEY)) return false;
  if (k.storage.get(CURSOR_KEY) != null) return false;
  return (await k.catalog.count()) > 0;
}

/** Titles whose name contains every word of `query`, those starting with it first. */
export async function searchCatalog(query, limit = 50) {
  const q = String(query || "").trim().slice(0, 256);
  if (!q) return [];
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 50));
  const res = await getKino().catalog.search({ q, limit: n, order: "newest" });
  const needle = q.toLowerCase();
  const items = res.items.map(fromStored);
  const starts = (it) => (it.title.toLowerCase().startsWith(needle) ? 0 : 1);
  return items.map((it, i) => ({ it, i })).sort((a, b) => starts(a.it) - starts(b.it) || a.i - b.i).map((x) => x.it);
}

/**
 * One page of a category (optionally one genre), newest first, scanning kino.catalog from `offset` (a position in the
 * whole catalog, not in the category). `next` is where to continue, or null at the end (also when a whole scan window finds nothing). An empty category (Duanju) is
 * recognized from the lists saved by the import and answers at once instead of scanning everything.
 */
export async function browseCategory(categoryKey, { offset = 0, limit = 20, genre = "" } = {}) {
  const lists = readJson(RECENT_KEY);
  if (!genre && lists && Array.isArray(lists[categoryKey]) && lists[categoryKey].length === 0) return { items: [], next: null };

  const want = String(genre || "").toLowerCase();
  const items = [];
  let pos = Math.max(0, Math.floor(Number(offset)) || 0);
  for (let page = 0; page < BROWSE_SCAN_PAGES; page++) {
    const res = await getKino().catalog.search({ limit: SCAN_PAGE, offset: pos, order: "newest" });
    for (let i = 0; i < res.items.length; i++) {
      const item = fromStored(res.items[i]);
      if (item.categoryKey !== categoryKey) continue;
      if (want && !item.genres.some((g) => g.toLowerCase() === want)) continue;
      items.push(item);
      if (items.length >= limit) return { items, next: pos + i + 1 < res.total ? pos + i + 1 : null };
    }
    pos += res.items.length;
    if (!res.items.length || pos >= res.total) return { items, next: null };
  }
  // A full window with nothing in the category: stop paging instead of handing back a dead "load more".
  return { items, next: items.length ? pos : null };
}
