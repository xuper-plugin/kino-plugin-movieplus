// Playback resolution for Movie+: movie variants / series episode documents → opaque Movp2 tokens → direct Yandex CDN url.
// Every request goes through session.js's signed call(); kino.error / kino.crypto are read from globalThis.kino at call time,
// so the module also runs under node --test with a shim.

import { call, ensureSession } from "./session.js";

const SCHEMA_VERSION = 1;
const VARIANT_SEP = ",_,";
const EPISODE_SEP = "_SPLIT_";
const FOLDER_SEP = "_FOLDER_";
const TOKEN_PREFIX = "Movp2!::";
const SERIES_ID = /^[1-9][0-9]{0,9}$/;
const EPISODE_CODE = /S(\d+)E(\d+)/i;
const SEASON_KEY = /Temporada\s*(\d+)/i;

const getKino = () => globalThis.kino;

function fail(code, message, userMessage) {
  return getKino().error(code, message, userMessage ? { userMessage } : undefined);
}

function grant(session, name) {
  const id = session.grants && session.grants[name];
  if (!id) throw fail("unavailable", `Movie+ session has no ${name} grant`);
  return id;
}

export function qualityRank(quality) {
  const q = String(quality).toLowerCase();
  if (/4k|uhd/.test(q)) return 2160;
  const m = q.match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

const byQualityDesc = (a, b) => qualityRank(b.quality) - qualityRank(a.quality);

export async function movieStreams(movieId) {
  const id = /^\d+$/.test(String(movieId)) ? Number(movieId) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw fail("invalid_request", `bad movie id: ${movieId}`);

  const s = await ensureSession();
  const resp = await call("/v3/client/movie-variants", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog"),
    movieId: id,
  });

  const raw = (resp && resp.movieLinks && resp.movieLinks.variants) || [];
  const streams = [];
  for (const variant of raw) {
    const parts = String(variant).split(VARIANT_SEP);
    if (parts.length < 3) continue;
    const quality = parts[0].trim();
    const size = parts.slice(1, -1).join(VARIANT_SEP).trim();
    const token = parts[parts.length - 1].trim();
    if (quality && size && token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length) {
      streams.push({ quality, size, token });
    }
  }
  if (!streams.length) {
    throw fail("not_found", `no variants for movie ${id}`, "Esta película no tiene enlaces disponibles ahora.");
  }
  return streams;
}

function parseSeasonKey(key) {
  const slash = key.indexOf("/");
  const head = slash < 0 ? key : key.slice(0, slash);
  const quality = slash < 0 ? "" : key.slice(slash + 1).trim();
  const m = head.match(SEASON_KEY) || head.match(/(\d+)/);
  return { season: m ? Number(m[1]) : 1, quality };
}

function parseEpisodeEntry(entry) {
  const parts = String(entry).split(EPISODE_SEP);
  if (parts.length < 3) return null;
  const name = parts[0].trim();
  const token = parts[1].trim();
  const size = parts[2].split(FOLDER_SEP)[0].trim();
  return name && token.startsWith(TOKEN_PREFIX) ? { name, token, size } : null;
}

// Seasons is a Map<season number, episodes sorted by number>. An episode carries the highest-quality variant at the top
// level ({s, e, name, token, size, quality}) plus every quality in `variants` (highest first).
export async function seriesDocument(seriesId) {
  const docId = String(seriesId);
  if (!SERIES_ID.test(docId)) throw fail("invalid_request", `bad series id: ${seriesId}`);

  const s = await ensureSession();
  const resp = await call("/v3/client/document", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog"),
    collection: "tv",
    documentId: docId,
    minVersion: 0,
    freshRequest: getKino().crypto.uuid(),
  });

  const data = resp && resp.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw fail("not_found", `no episode document for series ${docId}`, "Esta serie no tiene episodios disponibles ahora.");
  }

  const bySeason = new Map();
  for (const key of Object.keys(data)) {
    const entries = Array.isArray(data[key]) ? data[key].map(parseEpisodeEntry).filter(Boolean) : [];
    const { season: keySeason, quality } = parseSeasonKey(key);

    const parsed = entries.map((ent) => {
      const m = ent.name.match(EPISODE_CODE);
      return { ...ent, s: m ? Number(m[1]) : keySeason, e: m ? Number(m[2]) : null };
    });
    const used = new Set(parsed.filter((p) => p.e !== null).map((p) => `${p.s}:${p.e}`));
    let next = 1;
    for (const p of parsed) {
      if (p.e !== null) continue;
      while (used.has(`${p.s}:${next}`)) next++;
      p.e = next;
      used.add(`${p.s}:${next}`);
    }

    for (const p of parsed) {
      if (!bySeason.has(p.s)) bySeason.set(p.s, new Map());
      const episodes = bySeason.get(p.s);
      if (!episodes.has(p.e)) episodes.set(p.e, []);
      const variants = episodes.get(p.e);
      if (!variants.some((v) => v.quality === quality)) variants.push({ quality, token: p.token, size: p.size, name: p.name });
    }
  }

  const seasons = new Map();
  for (const num of [...bySeason.keys()].sort((a, b) => a - b)) {
    const episodes = bySeason.get(num);
    seasons.set(num, [...episodes.keys()].sort((a, b) => a - b).map((e) => {
      const variants = episodes.get(e).sort(byQualityDesc);
      const best = variants[0];
      return { s: num, e, name: best.name, token: best.token, size: best.size, quality: best.quality, variants };
    }));
  }
  if (!seasons.size) {
    throw fail("not_found", `no episodes in document for series ${docId}`, "Esta serie no tiene episodios disponibles ahora.");
  }
  return { seasons };
}

export async function resolveToken(token, resolveProvider = true) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    throw fail("invalid_request", "bad Movie+ playback token");
  }

  const s = await ensureSession();
  const resp = await call("/v3/client/playback", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog-value"),
    token,
    issuedAtMs: Math.floor(Date.now() / 1000) * 1000 - 1000,
    resolveProvider: !!resolveProvider,
  });

  if (!resp || resp.status !== "resolved" || !resp.value) {
    throw fail(
      "unavailable",
      `playback not resolved (status ${resp && resp.status ? resp.status : "missing"})`,
      "No se pudo obtener el enlace de reproducción. Prueba de nuevo o elige otra calidad.",
    );
  }
  return resp.value;
}
