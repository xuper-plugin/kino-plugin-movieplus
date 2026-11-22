// The Movie+ "recipe" — the appsxploit API base, version/channel params and request-signing prefixes the plugin needs to
// make valid backend requests — lives in the Kino secrets vault (oleada), NOT hardcoded here. The plugin reads it with ONE
// call, kino.vault.get() (apiVersion 28, capability "vault", which requires "identity"): Kino runs the whole exchange from
// inside — it mints a challenge, attests this plugin (its per-plugin pseudonym, a device-key signature, its author fingerprint
// and code hash, and — because Movie+ is signed by a trusted author — the gate token, so the vault verifies group membership
// LIVE) and reads the secret the vault resolves for THIS plugin by its (pluginId, author). The plugin never sees the vault's
// address, the challenge nor the scope it resolves by, so it can only ever read its own secret, and a copy re-signed with a
// different key resolves a different (missing) scope. There is NO hardcoded fallback on purpose: a copy of this plugin, or
// anyone outside the group, gets no recipe and cannot talk to the Movie+ backend at all; rotating the recipe in the vault also
// kills copies that cached an old value.
//
// kino.vault.get() answers only inside a person-started SCREEN call, so the recipe is minted on the screen's `open` event
// (ensureRecipe) and cached ~1h; every other surface (playback/session) reads the cache via recipe().

const RECIPE_KEY = "movp:recipe:v1";
const SEEN_KEY = "movp:recipe:seen:v1"; // persists past the cache TTL: "this install did get its recipe once" (setupStatus cannot call the vault)
const TTL_MS = 60 * 60 * 1000; // ~1h: a normal user opens Movie+ far under the vault's rate limit, and rotation propagates within this
const REQUIRED = ["apiBase", "appVersion", "versionCode", "channel", "settingsProfile", "reqPrefix", "sessionPrefix"];

const getKino = () => globalThis.kino;

function valid(r) {
  return !!r && typeof r === "object" && REQUIRED.every((k) => r[k] != null) && /^https:\/\//.test(String(r.apiBase));
}

/** The cached recipe if still fresh, else null. */
function cached() {
  try {
    const raw = getKino().storage.get(RECIPE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && Number(o.at) && Date.now() - Number(o.at) < TTL_MS && valid(o.recipe)) return o.recipe;
  } catch (_) { /* unreadable: treat as none */ }
  return null;
}

/** The recipe for a backend call, or throws `recipe_unavailable` when it was never minted (open Movie+ to activate). */
export function recipe() {
  const r = cached();
  if (!r) throw getKino().error("recipe_unavailable", "Abre Movie+ para activarlo y vuelve a intentarlo.");
  return r;
}

/** Whether this install ever obtained its recipe (survives the cache TTL; no network, no vault call). */
export function recipeSeen() {
  try { return getKino().storage.get(SEEN_KEY) != null || cached() != null; } catch (_) { return false; }
}

/** Whether a fresh recipe is cached (no network). */
export function hasRecipe() { return cached() != null; }

/** Forget the cached recipe (e.g. on a members gate, or to force a re-mint). */
export function clearRecipe() { try { getKino().storage.remove(RECIPE_KEY); getKino().storage.remove(SEEN_KEY); } catch (_) { /* best effort */ } }

/**
 * Mint the recipe from the vault. MUST run inside a person-started screen call (kino.vault.get). On success it caches and
 * returns the recipe. Re-throws `not_member` (not in the group, or a copy whose scope does not match — the screen shows the
 * members gate), `not_found` (no secret registered), `rate_limited`, and maps anything else to `unavailable`. A cached fresh
 * recipe short-circuits with no network.
 */
export async function ensureRecipe() {
  const have = cached();
  if (have) return have;
  const k = getKino();
  if (!k.vault || typeof k.vault.get !== "function") {
    // apiVersion 28 guarantees kino.vault; this only trips on an older Kino that could not install Movie+ anyway.
    throw k.error("unavailable", "Movie+ necesita una versión más nueva de Kino.");
  }
  let r;
  try {
    try { k.log && k.log("Movie+ vault: calling kino.vault.get()"); } catch (_) {}
    r = await k.vault.get();
  } catch (e) {
    const code = (e && e.code) || "unavailable";
    try { k.log && k.log("Movie+ vault: kino.vault.get threw code=" + code); } catch (_) {}
    if (code === "not_member") throw k.error("not_member", "Movie+ es para los miembros del grupo de Kino.");
    if (code === "not_found") throw k.error("unavailable", "Movie+ no está disponible ahora mismo.");
    if (code === "rate_limited") throw k.error("rate_limited", "Demasiadas solicitudes a Movie+; intenta en un momento.");
    throw k.error("unavailable", "No se pudo activar Movie+. Revisa tu conexión y reintenta.");
  }
  if (!valid(r)) throw k.error("unavailable", "the Movie+ recipe from the vault is invalid");
  try { k.storage.set(RECIPE_KEY, JSON.stringify({ at: Date.now(), recipe: r })); } catch (_) { /* storage full: next open re-mints */ }
  try { k.storage.set(SEEN_KEY, "1"); } catch (_) { /* best effort */ }
  try { k.log && k.log("Movie+ vault: recipe ready"); } catch (_) {}
  return r;
}
