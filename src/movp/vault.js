// The Movie+ "recipe" — the appsxploit API base, version/channel params and request-signing prefixes the plugin needs to
// make valid backend requests — lives in the Kino secrets vault (oleada), NOT hardcoded here. The plugin reads it at
// runtime, gated SERVER-SIDE by: membership of the Kino Telegram group + the plugin's signed author fingerprint + its id
// (the scope registered in the vault panel). There is NO hardcoded fallback on purpose: a copy of this plugin re-signed
// with a different key — or anyone outside the group — gets 403 and never obtains the recipe, so it cannot talk to the
// Movie+ backend at all. Rotating the recipe in the panel also kills copies that cached an old value.
//
// kino.identity answers only inside a person-started SCREEN call, so the recipe is minted on the screen's `open` event
// (ensureRecipe) and cached ~1h; every other surface (playback/session) reads the cache via recipe().

const VAULT_BASE = "https://secrets.kinoverse.app";
const OWNER = "xuper-plugin";
const REPO = "kino-plugin-movieplus";
const PLUGIN_ID = "movieplus";
const RECIPE_KEY = "movp:recipe:v1";
const TTL_MS = 60 * 60 * 1000; // ~1h: a normal user opens Movie+ far under the 120/h vault limit, and rotation propagates within this
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

/** Whether a fresh recipe is cached (no network). */
export function hasRecipe() { return cached() != null; }

/** Forget the cached recipe (e.g. on a members gate, or to force a re-mint). */
export function clearRecipe() { try { getKino().storage.remove(RECIPE_KEY); } catch (_) { /* best effort */ } }

async function fetchChallenge() {
  const resp = await getKino().fetch(VAULT_BASE + "/session/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (!resp.ok) throw getKino().error("unavailable", `vault challenge HTTP ${resp.status}`);
  const data = resp.json();
  if (!data || !data.challenge) throw getKino().error("unavailable", "vault challenge missing");
  return data.challenge;
}

/**
 * Mint the recipe from the vault. MUST run inside a person-started screen call (kino.identity). On 200 it caches and
 * returns the recipe. Throws `not_member` on 403 (not in the group, or a copy whose author/scope does not match — the
 * screen shows the members gate), `rate_limited` on 429, `unavailable` on anything else. A cached fresh recipe short-
 * circuits with no network.
 */
export async function ensureRecipe() {
  const have = cached();
  if (have) return have;
  const k = getKino();
  const challenge = await fetchChallenge();
  try { k.log && k.log("Movie+ vault: challenge ok, calling kino.identity"); } catch (_) {}
  let idp;
  try {
    idp = await k.identity.telegram({ challenge });
  } catch (e) {
    try { k.log && k.log("Movie+ vault: kino.identity threw code=" + ((e && e.code) || "?") + " msg=" + ((e && e.message) || e)); } catch (_) {}
    throw e;
  }
  try { k.log && k.log("Movie+ vault: identity id=" + (idp && idp.id ? "yes" : "no") + " deviceKey=" + (idp && idp.deviceKey ? "yes" : "no") + " sig=" + (idp && idp.signature ? "yes" : "no") + " author=" + (idp && idp.author) + " codeHash=" + (idp && idp.codeHash ? "yes" : "no") + " token=" + (idp && idp.token ? "yes" : "no")); } catch (_) {}
  if (!idp || !idp.id || !idp.deviceKey || !idp.signature) throw k.error("unavailable", "kino.identity did not sign the vault challenge");
  const body = {
    pluginId: PLUGIN_ID,
    challenge,
    id: idp.id,
    deviceKey: idp.deviceKey,
    signature: idp.signature,
    author: idp.author,
    codeHash: idp.codeHash,
  };
  // Movie+ is signed with a token author (E04E), so kino.identity also returns the raw gate token. When present, send it:
  // the vault verifies it with the bot's key (like /session), resolves the real Telegram id and checks group membership
  // LIVE — so it works for ANY real member, not only the ~1.5% who ever did a token /session (the vault's member table
  // cannot enumerate a 34k-member group). The backend treats `token` as optional and falls back to the pseudonym
  // reverse-map when it is absent, so this stays compatible with the universal (token-less) path.
  if (idp.token) body.token = idp.token;
  const resp = await k.fetch(VAULT_BASE + `/secrets/${OWNER}/${REPO}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try { k.log && k.log("Movie+ vault: POST /secrets -> " + resp.status); } catch (_) {}
  if (resp.status === 403) throw k.error("not_member", "Movie+ es para los miembros del grupo de Kino.");
  if (resp.status === 429) throw k.error("rate_limited", "Demasiadas solicitudes a Movie+; intenta en un momento.");
  if (!resp.ok) throw k.error("unavailable", `vault read HTTP ${resp.status}`);
  const data = resp.json();
  const r = data && data.secret;
  if (!valid(r)) throw k.error("unavailable", "the Movie+ recipe from the vault is invalid");
  try { k.storage.set(RECIPE_KEY, JSON.stringify({ at: Date.now(), recipe: r })); } catch (_) { /* storage full: next open re-mints */ }
  return r;
}
