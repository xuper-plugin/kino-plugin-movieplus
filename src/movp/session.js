// Anonymous signed session for api.appsxploit.dev: challenge → session (registers our RSA key) → bootstrap → auth guest.
// Every /v2/client/* request after the session carries RSA-signed X-MOVP-* headers. Primitives come from ./crypto.js and
// kino.fetch / kino.storage are read from globalThis.kino at call time, so the module also runs under node --test.

import { getIdentity, signPkcs1, sha256hex } from "./crypto.js";
import { recipe } from "./vault.js";

// The backend address, app-version/channel params and request-signing prefixes are NOT hardcoded: recipe() reads them
// from the Kino secrets vault (src/movp/vault.js), minted once per screen open and gated server-side by group membership
// + this plugin's signed author key. With no recipe (a copy re-signed with another key, or a non-member) recipe() throws
// `recipe_unavailable`, so the plugin can never reach the Movie+ backend.
const STORAGE_KEY = "movp:session:v1";
const EXPIRY_MARGIN_MS = 30000;
const DEFAULT_TTL_MS = 9 * 60 * 1000;
const SESSION_ERROR = /session/i;

const getKino = () => globalThis.kino;

function httpError(message, status, extra) {
  const err = getKino().error("unavailable", message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function post(path, bodyObj, headers) {
  const resp = await getKino().fetch(recipe().apiBase + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(bodyObj),
  });
  const text = resp.text ? resp.text() : null;
  const data = text ? parseBody(text) : null;
  const reason = data && (data.error || data.code);
  const sessionInvalid = resp.status === 401 || (!!reason && typeof reason === "string" && SESSION_ERROR.test(reason));
  if (!resp.ok || (data && data.ok === false && sessionInvalid)) {
    if (resp.status === 403) getKino().log("info", `[movp-debug] 403 raw(200): ${String(text).slice(0, 200)}`);
    throw httpError(`${path} failed (HTTP ${resp.status}${reason ? ", " + reason : ""})`, resp.status, { sessionInvalid });
  }
  return data === null ? {} : data;
}

export async function signedFetch(path, bodyObj, sessionToken) {
  const token = sessionToken || readStored()?.sessionToken;
  if (!token) throw getKino().error("invalid_request", "no Movie+ session token to sign with");
  const r = recipe();
  const body = JSON.stringify(bodyObj);
  const nonce = getKino().crypto.uuid().replace(/-/g, "");
  const preimage = `${r.reqPrefix}\nPOST\n${path}\n${sha256hex(body)}\n${nonce}\n${sha256hex(token)}`;
  return post(path, bodyObj, {
    "X-MOVP-Hybrid-Session": token,
    "X-MOVP-Hybrid-Nonce": nonce,
    "X-MOVP-Hybrid-Signature": signPkcs1(getIdentity(), preimage),
    "X-MOVP-App-Version": r.appVersion,
    "X-MOVP-App-Version-Code": String(r.versionCode),
  });
}

function readStored() {
  try {
    const saved = JSON.parse(getKino().storage.get(STORAGE_KEY) || "null");
    if (saved && saved.sessionToken && saved.grants && saved.expiresAtMs) return saved;
  } catch (_) { /* unreadable copy: treat as no session */ }
  return null;
}

function clearStored() {
  getKino().storage.remove(STORAGE_KEY);
}

async function handshake() {
  const r = recipe();
  getKino().log("info", `[movp-debug] challenge versionCode=${r.versionCode} appVersion=${r.appVersion}`);
  const id = getIdentity();
  const challenge = await post("/v2/client/challenge", { schemaVersion: 1, versionCode: r.versionCode });
  const jwt = challenge.challenge;
  if (!jwt) throw getKino().error("unavailable", "Movie+ challenge missing");

  const session = await post("/v2/client/session", {
    schemaVersion: 1,
    publicKeySpki: id.spkiB64,
    challenge: jwt,
    deviceId: id.deviceId,
    signature: signPkcs1(id, `${r.sessionPrefix}\n${jwt}\n${id.deviceId}`),
  });
  const token = session.sessionToken;
  if (!token) throw getKino().error("unavailable", "Movie+ session token missing");

  const grants = {};
  const bootstrap = await signedFetch("/v2/client/bootstrap", {
    schemaVersion: 1,
    deviceId: id.deviceId,
    channel: r.channel,
    settingsProfile: r.settingsProfile,
  }, token);
  Object.assign(grants, (bootstrap.admission && bootstrap.admission.grants) || bootstrap.grants || {});

  const auth = await signedFetch("/v2/client/auth", {
    schemaVersion: 1,
    deviceId: id.deviceId,
    action: "guest",
    payload: { deviceKey: id.deviceId, appVersion: r.appVersion, platform: "android" },
  }, token);
  Object.assign(grants, (auth.admission && auth.admission.grants) || {});

  if (!grants.catalog || !grants["catalog-value"]) {
    throw getKino().error("unavailable", "Movie+ did not return the catalog grants");
  }

  // The server's own clock decides validity: ttl = expiresAtMs - serverNowMs, applied to the local clock.
  const ttl = session.expiresAtMs && session.serverNowMs ? session.expiresAtMs - session.serverNowMs : DEFAULT_TTL_MS;
  const saved = { sessionToken: token, grants, deviceId: id.deviceId, expiresAtMs: Date.now() + ttl };
  getKino().storage.set(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

export async function ensureSession() {
  let s = readStored();
  if (!s || s.expiresAtMs - EXPIRY_MARGIN_MS <= Date.now()) s = await handshake();
  return { sessionToken: s.sessionToken, grants: s.grants, deviceId: s.deviceId };
}

export async function call(path, bodyObj) {
  const s = await ensureSession();
  try {
    return await signedFetch(path, bodyObj, s.sessionToken);
  } catch (err) {
    if (!(err && (err.status === 401 || err.sessionInvalid))) throw err;
    clearStored();
    const fresh = await ensureSession();
    return signedFetch(path, bodyObj, fresh.sessionToken);
  }
}
