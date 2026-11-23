// The branded Movie+ screen: gate (download + import the catalog) until the catalog is ready, then a top bar, category
// tabs and poster rows. Detail and search are Kino's NATIVE ones (the screen hands off with `go`).
// screen() is a PURE view of `state`; the catalog is read in screenEvent (open/tab/refresh) and handed back in state.

import { CATEGORIES, catalogCount, isCatalogReady, recentByCategory } from "../movp/catalog.js";
import { ensureSession } from "../movp/session.js";
import { ensureRecipe } from "../movp/vault.js";
import { card } from "../contract/index.js";
import { GATE_EVENTS, gateView, handleGateEvent, needsGate } from "./gate.js";
import { heroSlides } from "./hero.js";
import { DEFAULT_TAB, SETTINGS_TAB, richView, tabKeyOf } from "./view.js";

const LOAD_ITEMS = 60;
const RECENT_ROW = 20;
const GENRE_ROWS = 3;
const GENRE_MIN = 4;
const QUERY_MAX = 200;

function genreRows(items, key) {
  const counts = new Map();
  for (const it of items) for (const g of it.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= GENRE_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, GENRE_ROWS)
    .map(([g]) => ({ title: g, titleEn: g, ref: key + ":" + g, items: items.filter((it) => (it.genres || []).includes(g)).slice(0, RECENT_ROW) }));
}

/** The rows of a category tab, from the catalog. Runs in screenEvent only. */
async function loadView(tab) {
  if (tab === SETTINGS_TAB) return { tab, count: await catalogCount() };
  const cat = CATEGORIES.find((c) => c.key === tab);
  const items = (await recentByCategory(tab, LOAD_ITEMS)).map(card);
  const rows = [];
  let slides = [];
  if (items.length) {
    slides = await heroSlides(items);
    rows.push({ title: `${cat.label}: recientes`, titleEn: `${cat.labelEn}: recent`, ref: tab, items: items.slice(0, RECENT_ROW) });
    rows.push(...genreRows(items, tab));
  }
  return { tab, rows, slides };
}

async function readyState(tab) {
  const t = tabKeyOf(tab);
  return { ready: true, empty: false, downloading: false, importing: false, tab: t, view: await loadView(t) };
}

// PURE VIEW: render ONLY from `state`.
export async function screen(arg) {
  const state = (arg && arg.state) || {};
  return needsGate(state) ? gateView(state) : richView(state);
}

// An import that just finished leaves the gate: load the first tab so the rich view has rows to draw.
async function afterGate(answer, state) {
  const merged = { ...state, ...((answer && answer.state) || {}) };
  if (!answer || !answer.state || needsGate(merged)) return answer;
  return { ...answer, state: { ...answer.state, ...(await readyState(merged.tab || DEFAULT_TAB)) } };
}

export async function screenEvent(ev) {
  const name = ev && (ev.name != null ? ev.name : ev.event);
  const value = ev && (ev.value != null ? ev.value : ev.arg);
  const state = (ev && ev.state) || {};
  try {
    if (name === "open" || name === "verify") {
      // TWO STEPS. Step 1: verify vault access BEFORE anything else — mint the backend recipe (kino.identity works only
      // here, a person-started screen call). The vault is gated server-side by group membership + this plugin's signed
      // author key, so a non-member — or a copy re-signed with another key — fails here and the catalog is NEVER
      // downloaded. A cached recipe makes this instant. `verify` is the gate's retry button.
      const clear = { members: false, verifyFailed: false };
      try {
        await ensureRecipe();
      } catch (e) {
        const code = e && e.code;
        if (code === "not_member") return { state: { ready: true, members: true, verifyFailed: false, downloading: false, importing: false, empty: false } };
        // offline / rate limit / identity error: a retry gate, NOT a silent catalog download
        // The vault says why (its userMessage, already in the person's language): "Valida tu Telegram…" beats a generic line.
        const why = e && typeof e.userMessage === "string" && e.userMessage ? e.userMessage : null;
        return { state: { ready: true, verifyFailed: true, verifyWhy: why, members: false } };
      }
      // Step 2: access verified → the catalog gate (download/import).
      const base = { ...state, ...clear };
      const answer = await handleGateEvent("open", value, base);
      const merged = { ...base, ...(answer.state || {}), ...clear };
      if (needsGate(merged)) return { state: { ...(answer.state || {}), ...clear } };
      try {
        await ensureSession();
      } catch (_) { /* offline: browsing the local catalog still works, playback retries the session */ }
      return { state: { ...clear, ...await readyState(state.tab || DEFAULT_TAB) } };
    }
    if (GATE_EVENTS.has(name)) return afterGate(await handleGateEvent(name, value, state), state);
    switch (name) {
      case "close_screen":
        return { close: true };
      case "tab": {
        const tab = tabKeyOf(value);
        return { state: { searching: false, ...(await readyState(tab)) } };
      }
      case "open_search":
        return { state: { searching: true } };
      case "close_search":
        return { state: { searching: false } };
      case "search": {
        const typed = value != null && String(value).trim() ? value : state.inputs && state.inputs.q;
        const q = String(typed == null ? "" : typed).trim().slice(0, QUERY_MAX);
        return q ? { go: { search: { q } }, state: { searching: false } } : { state: { searching: false } };
      }
      case "open_settings":
        return { state: { searching: false, ready: true, empty: false, tab: SETTINGS_TAB, view: await loadView(SETTINGS_TAB) } };
      case "refresh": {
        if (!(await isCatalogReady())) return { state: { ready: true, empty: true } };
        return { state: await readyState(state.tab) };
      }
      default:
        return {};
    }
  } catch (e) {
    try { globalThis.kino.log("screenEvent " + name + " failed: " + ((e && (e.code || e.message)) || e)); } catch (_) { /* no log */ }
    // ready + empty makes needsGate true: the gate's download button is the way out of a failed load
    return { state: { ready: true, empty: true }, toast: { text: "No se pudo cargar el catálogo", textEn: "Could not load the catalog", role: "error" } };
  }
}
