// Kino contract exports for Movie+: home, browse, search, details, episodes, resolve.
// Cards come straight from kino.catalog (no TMDB call per card); TMDB (kino.tmdb) only fills details and episode names.
// Playback tokens live ~60 s, so resolve() asks for the direct url at play time and never while listing.

import {
  CATEGORIES, browseCategory, isCatalogReady, recentByCategory, searchCatalog,
} from "../movp/catalog.js";
import { movieStreams, qualityRank, resolveToken, seriesDocument } from "../movp/resolve.js";

const getKino = () => globalThis.kino;

const IMG = "https://image.tmdb.org/t/p/";
const PAGE = 20;
const HOME_ROW = 20;
const SEARCH_MAX = 50;
const DEFAULT_CAP = 1080;
const GENRE_OF = { peliculas: "peliculas", series: "series", animes: "anime", doramas: "series", telenovelas: "series", duanju: "series" };

const isEn = () => getKino().lang === "en";
const text = (es, en) => (isEn() ? en : es);
const tmdbLang = () => (isEn() ? "en-US" : "es-MX");
const img = (size, p) => {
  if (!p) return undefined;
  return /^https?:\/\//.test(p) ? p : IMG + size + p;
};
const yearOf = (d) => (typeof d === "string" && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);
const rounded = (v) => (v ? Math.round(v * 10) / 10 : undefined);

function notFound(message) {
  return getKino().error("not_found", message, { userMessage: text("No se encontró este título.", "Title not found.") });
}

async function tmdb(path, params = {}) {
  const k = getKino();
  try {
    return await k.tmdb(path, { language: tmdbLang(), ...params });
  } catch (e) {
    if (e && e.code === "not_found") throw notFound("tmdb 404 " + path);
    if (e && e.userMessage) throw e;
    throw k.error("unavailable", `tmdb ${path} ${e && e.code}`, {
      userMessage: text("No se pudo cargar la información del título.", "Could not load the title's information."),
    });
  }
}

function parseRef(ref) {
  const s = String(ref || "");
  const hash = s.indexOf("#");
  const base = hash < 0 ? s : s.slice(0, hash);
  const quality = hash < 0 ? "" : s.slice(hash + 1);
  let m = /^m:(\d{1,10})$/.exec(base);
  if (m) return { kind: "movie", id: m[1], base, quality };
  m = /^s:(\d{1,10})$/.exec(base);
  if (m) return { kind: "series", id: m[1], base, quality };
  m = /^e:(\d{1,10}):(\d{1,3}):(\d{1,5})$/.exec(base);
  if (m) return { kind: "episode", id: m[1], season: Number(m[2]), number: Number(m[3]), base, quality };
  return null;
}

export function card(item) {
  const prefix = item.kind === "movie" ? "m" : "s";
  const tmdbId = Number(item.id.slice(2));
  return {
    id: prefix + tmdbId,
    ref: `${prefix}:${tmdbId}`,
    title: item.title,
    kind: item.kind,
    year: item.year ? Number(item.year) : undefined,
    poster: img("w342", item.poster),
    genres: item.genres.length ? item.genres.slice(0, 5) : undefined,
    ids: { tmdb: tmdbId },
  };
}

export async function search(query) {
  const q = typeof query === "string" ? query : (query && query.q) || "";
  if (!String(q).trim()) return [];
  return (await searchCatalog(q, SEARCH_MAX)).map(card);
}

export async function home() {
  if (!(await isCatalogReady())) return [];
  const settled = await Promise.allSettled(CATEGORIES.map((c) => recentByCategory(c.key, HOME_ROW)));
  const rows = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value.length) return;
    const c = CATEGORIES[i];
    rows.push({
      id: "recent-" + c.key,
      title: text(`${c.label}: recientes`, `${c.labelEn}: recent`),
      ref: c.key,
      items: r.value.map(card),
      genre: GENRE_OF[c.key],
    });
  });
  return rows;
}

export async function browse(ref, cursor) {
  const [key, ...rest] = String(ref || "").split(":");
  if (!CATEGORIES.some((c) => c.key === key)) throw notFound("unknown browse ref: " + ref);
  const offset = Math.max(0, parseInt(cursor || "0", 10) || 0);
  const page = await browseCategory(key, { offset, limit: PAGE, genre: rest.join(":") });
  const out = { items: page.items.map(card) };
  if (page.next != null) out.next = String(page.next);
  return out;
}

function infoOf(d, tv) {
  return {
    title: (tv ? d.name : d.title) || "",
    poster: img("w500", d.poster_path),
    backdrop: img("w1280", d.backdrop_path),
    overview: d.overview || undefined,
    genres: (d.genres || []).map((g) => g.name).slice(0, 5),
    year: yearOf(tv ? d.first_air_date : d.release_date),
    rating: rounded(d.vote_average),
    ids: { tmdb: d.id },
  };
}

export async function details(ref) {
  const p = parseRef(ref);
  if (!p || p.kind === "episode") return null;
  if (p.kind === "series") return infoOf(await tmdb("/tv/" + p.id), true);
  const d = await tmdb("/movie/" + p.id);
  return { ...infoOf(d, false), runtimeMinutes: d.runtime > 0 ? d.runtime : undefined };
}

// append_to_response takes up to 20 sub-requests per call.
async function seasonInfo(id, seasons) {
  const info = new Map();
  let show = null;
  try {
    const groups = [];
    for (let i = 0; i < seasons.length; i += 19) groups.push(seasons.slice(i, i + 19));
    const blocks = await Promise.all(groups.map((g) => tmdb("/tv/" + id, { append_to_response: g.map((s) => "season/" + s).join(",") })));
    show = blocks[0] || null;
    blocks.forEach((b, bi) => {
      for (const s of groups[bi]) {
        for (const ep of (b["season/" + s] && b["season/" + s].episodes) || []) info.set(`${s}.${ep.episode_number}`, ep);
      }
    });
  } catch (_) { /* no TMDB: the episodes still play, numbered only */ }
  return { show, info };
}

export async function episodes(ref) {
  const p = parseRef(ref);
  if (!p || p.kind !== "series") throw notFound("not a series ref: " + ref);
  const { seasons } = await seriesDocument(p.id);
  const { show, info } = await seasonInfo(p.id, [...seasons.keys()]);

  const out = [];
  for (const [s, list] of seasons) {
    for (const ep of list) {
      const t = info.get(`${s}.${ep.e}`);
      out.push({
        season: s,
        number: ep.e,
        ref: `e:${p.id}:${s}:${ep.e}`,
        title: (t && t.name) || text(`Episodio ${ep.e}`, `Episode ${ep.e}`),
        still: t ? img("w300", t.still_path) : undefined,
        overview: (t && t.overview) || undefined,
        airDate: t && /^\d{4}-\d{2}-\d{2}$/.test(t.air_date || "") ? t.air_date : undefined,
        runtimeMinutes: t && t.runtime > 0 && t.runtime <= 1000 ? t.runtime : undefined,
      });
    }
  }
  out.sort((a, b) => a.season - b.season || a.number - b.number);
  return show ? { series: infoOf(show, true), episodes: out } : { episodes: out };
}

function maxQualityCap() {
  let v;
  try { v = getKino().config.get("maxQuality"); } catch (_) { /* no settings: auto */ }
  const m = /^(\d{3,4})p$/i.exec(String(v || "").trim());
  return m ? Number(m[1]) : DEFAULT_CAP;
}

// Highest quality within the cap (1080p unless the person chose lower); when everything is above it, the lowest one.
function pickDefault(variants) {
  const cap = maxQualityCap();
  const ranked = [...variants].sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  return ranked.find((v) => qualityRank(v.quality) <= cap) || ranked[ranked.length - 1];
}

async function variantsOf(p) {
  if (p.kind === "movie") return movieStreams(p.id);
  const { seasons } = await seriesDocument(p.id);
  const ep = (seasons.get(p.season) || []).find((e) => e.e === p.number);
  if (!ep) throw notFound(`episode not found: ${p.base}`);
  return ep.variants;
}

const choose = (variants, quality) => (quality && variants.find((v) => v.quality === quality)) || pickDefault(variants);

function sizeText(size) {
  const n = /^\d+$/.test(String(size)) ? Number(size) : NaN;
  if (!Number.isFinite(n)) return String(size || "");
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  return Math.round(n / 1024 ** 2) + " MB";
}
const labelOf = (v) => [v.quality, sizeText(v.size)].filter(Boolean).join(" · ").slice(0, 48);

export async function resolve(ref) {
  const p = parseRef(ref);
  if (!p || p.kind === "series") throw notFound("not a playable ref: " + ref);

  let variants = await variantsOf(p);
  let chosen = choose(variants, p.quality);
  let url;
  try {
    url = await resolveToken(chosen.token);
  } catch (e) {
    if (!e || e.code !== "unavailable") throw e;
    variants = await variantsOf(p);
    chosen = choose(variants, chosen.quality);
    url = await resolveToken(chosen.token);
  }

  const alternatives = variants
    .filter((v) => v.quality !== chosen.quality)
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    .map((v) => ({ label: labelOf(v), ref: `${p.base}#${v.quality}` }));
  return { url, label: labelOf(chosen), ...(alternatives.length ? { alternatives } : {}) };
}
