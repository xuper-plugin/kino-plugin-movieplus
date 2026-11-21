// Hero slides for the Movie+ screen: the newest titles of the active tab, each with a real landscape
// backdrop (and logo when there is one) from Kino's own `kino.meta` — no TMDB key in the plugin, no extra
// hosts. The Movie+ catalog id IS the TMDB id (see contract/index.js `card`), so one lookup per title by its
// id gets the exact art. Answers are kept in kino.storage (`movp:hero:v1`, the oldest dropped past MAX) so a
// title is asked once. Nothing here throws: without kino.meta, or when nothing matches, the hero is just empty.

const KEY = "movp:hero:v1"; // id -> { b: backdrop url | "", l: logo url | "" }  ("" = asked, none found)
const MAX = 150;
const POOL = 8; // look at this many newest titles to fill the slides (room to skip ones without a backdrop)
const SLIDES = 5; // show at most this many
const BUDGET_MS = 6_000; // stop starting lookups past this on one load; the rest fills in on the next open, from cache
const HTTPS = /^https:\/\//;

const getKino = () => globalThis.kino;

function read() {
  try {
    const o = JSON.parse(getKino().storage.get(KEY) || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}

function write(book) {
  try {
    const ids = Object.keys(book);
    if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete book[id];
    getKino().storage.set(KEY, JSON.stringify(book));
  } catch (_) { /* full storage: asked again next time */ }
}

function metaUsable() {
  try { return typeof getKino().meta === "function"; } catch (_) { return false; }
}

/**
 * Hero slides from `cards` (contract cards, newest first). Looks up a backdrop (and logo) per title through
 * `kino.meta`, by its TMDB id, caching the answer; returns up to [SLIDES] cards that have a backdrop, each as
 * `{ id, ref, kind, title, image, logo? }`. A title asked once (even if it had no backdrop) is never asked
 * again. Never throws; no backdrops → `[]`.
 */
export async function heroSlides(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const book = read();
  const k = getKino();
  const canAsk = metaUsable();
  const end = Date.now() + BUDGET_MS;
  let dirty = false;
  const out = [];

  for (const c of list.slice(0, POOL)) {
    if (out.length >= SLIDES) break;
    if (!c || typeof c.id !== "string" || !(c.ids && Number.isInteger(c.ids.tmdb))) continue;
    let e = book[c.id];
    if (e === undefined && canAsk && Date.now() < end) {
      try {
        const a = await k.meta({
          type: c.kind === "series" ? "series" : "movie",
          ids: { tmdb: c.ids.tmdb },
          title: c.title,
          ...(c.year ? { year: c.year } : {}),
        });
        e = { b: a && typeof a.backdrop === "string" ? a.backdrop : "", l: a && typeof a.logo === "string" ? a.logo : "" };
        book[c.id] = e;
        dirty = true;
      } catch (err) {
        if (err && err.code === "rate_limited") break; // asked again on a later load
        continue; // transient (timeout, offline): leave it unasked, try next load
      }
    }
    if (e && HTTPS.test(e.b || "")) {
      out.push({ id: c.id, ref: c.ref, kind: c.kind, title: c.title, image: e.b, ...(e.l && HTTPS.test(e.l) ? { logo: e.l } : {}) });
    }
  }

  if (dirty) write(book);
  return out;
}
