import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/rsa-vectors.json", import.meta.url), "utf8"));
const responses = JSON.parse(readFileSync(new URL("./fixtures/session-responses.json", import.meta.url), "utf8"));

const store = new Map();
let fetchCalls = [];
let fetchHandler = () => { throw new Error("no fetch handler"); };

class KinoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

globalThis.kino = {
  crypto: {
    hash(alg, data, opts = {}) {
      const input = opts.inputEncoding === "hex" ? Buffer.from(data, "hex") : Buffer.from(data, "utf8");
      return createHash(alg).update(input).digest(opts.outputEncoding || "hex");
    },
    modPow(baseHex, expHex, modHex) {
      let base = BigInt("0x" + baseHex), exp = BigInt("0x" + expHex);
      const mod = BigInt("0x" + modHex);
      let r = 1n;
      base %= mod;
      while (exp > 0n) {
        if (exp & 1n) r = (r * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
      }
      return r.toString(16).padStart(Math.ceil(modHex.length / 2) * 2, "0");
    },
    randomBytes: (n, enc = "hex") => randomBytes(n).toString(enc),
    uuid: () => randomUUID(),
  },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  error: (code, message) => new KinoError(code, message),
  async fetch(url, opts = {}) {
    const call = { url, method: opts.method, headers: opts.headers || {}, body: opts.body };
    fetchCalls.push(call);
    const { status = 200, body } = await fetchHandler(call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, url, headers: {}, text: () => text, json: () => JSON.parse(text) };
  },
};

const { signedFetch, ensureSession, call } = await import("../src/movp/session.js");

const API = "https://api.appsxploit.dev";
const identity = {
  n: vectors.key.n_hex,
  e: vectors.key.e,
  d: vectors.key.d_hex,
  spkiB64: vectors.key.spki_b64,
  installationId: vectors.installationId,
  deviceId: "11111111-2222-4333-8444-555555555555",
};
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const verifyKey = createPublicKey({ key: Buffer.from(identity.spkiB64, "base64"), format: "der", type: "spki" });
const verifies = (message, sigB64) => createVerify("RSA-SHA256").update(message).verify(verifyKey, Buffer.from(sigB64, "base64"));

// Server stand-in: replays the recorded responses and checks the handshake order.
function handshakeServer({ tokens = ["tok-1", "tok-2", "tok-3"], reject401 = () => false } = {}) {
  let issued = 0;
  return (c) => {
    const path = c.url.slice(API.length);
    if (path === "/v2/client/challenge") return { body: responses.challenge };
    if (path === "/v2/client/session") {
      return { body: { ...responses.session, sessionToken: tokens[issued++] } };
    }
    if (reject401(c, path)) return { status: 401, body: { ok: false, error: "invalid_session" } };
    if (path === "/v2/client/bootstrap") return { body: responses.bootstrap };
    if (path === "/v2/client/auth") return { body: responses.auth };
    return { body: { ok: true, echo: path } };
  };
}

beforeEach(() => {
  store.clear();
  fetchCalls = [];
  store.set("movp:identity:v1", JSON.stringify(identity));
  store.set("movp:recipe:v1", JSON.stringify({ at: Date.now(), recipe: {
    apiBase: API, appVersion: "17.4", versionCode: 90355, channel: "prod", settingsProfile: 7,
    reqPrefix: "MOVP-HYBRID-REQUEST-V1", sessionPrefix: "MOVP-HYBRID-SESSION-V1",
  } }));
});

test("signedFetch: POST to API+path with the 5 X-MOVP headers and a verifiable signature", async () => {
  fetchHandler = () => ({ body: { ok: true, hello: "world" } });
  const body = { schemaVersion: 1, deviceId: identity.deviceId, channel: "prod", settingsProfile: 7 };
  const resp = await signedFetch("/v2/client/bootstrap", body, "SESSION-TOKEN");

  assert.deepEqual(resp, { ok: true, hello: "world" });
  assert.equal(fetchCalls.length, 1);
  const c = fetchCalls[0];
  assert.equal(c.url, API + "/v2/client/bootstrap");
  assert.equal(c.method, "POST");
  assert.equal(c.body, '{"schemaVersion":1,"deviceId":"11111111-2222-4333-8444-555555555555","channel":"prod","settingsProfile":7}');

  const h = c.headers;
  assert.equal(h["Content-Type"], "application/json");
  assert.equal(h["X-MOVP-Hybrid-Session"], "SESSION-TOKEN");
  assert.match(h["X-MOVP-Hybrid-Nonce"], /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/, "uuid4 without dashes");
  assert.equal(h["X-MOVP-App-Version"], "17.4");
  assert.equal(h["X-MOVP-App-Version-Code"], "90355");

  const preimage = `MOVP-HYBRID-REQUEST-V1\nPOST\n/v2/client/bootstrap\n${sha(c.body)}\n${h["X-MOVP-Hybrid-Nonce"]}\n${sha("SESSION-TOKEN")}`;
  assert.ok(verifies(preimage, h["X-MOVP-Hybrid-Signature"]), "signature must verify over the documented preimage");
});

test("signedFetch: a fresh nonce on every request", async () => {
  fetchHandler = () => ({ body: { ok: true } });
  await signedFetch("/v2/client/x", {}, "t");
  await signedFetch("/v2/client/x", {}, "t");
  assert.notEqual(fetchCalls[0].headers["X-MOVP-Hybrid-Nonce"], fetchCalls[1].headers["X-MOVP-Hybrid-Nonce"]);
});

test("signedFetch: HTTP 401 throws an error carrying status 401", async () => {
  fetchHandler = () => ({ status: 401, body: { ok: false, error: "invalid_session" } });
  await assert.rejects(() => signedFetch("/v2/client/x", {}, "t"), (e) => e.status === 401);
});

test("ensureSession: runs challenge→session→bootstrap→auth with the exact bodies", async () => {
  fetchHandler = handshakeServer();
  const s = await ensureSession();

  assert.deepEqual(fetchCalls.map((c) => c.url.slice(API.length)),
    ["/v2/client/challenge", "/v2/client/session", "/v2/client/bootstrap", "/v2/client/auth"]);

  assert.equal(fetchCalls[0].body, '{"schemaVersion":1,"versionCode":90355}');
  assert.equal(fetchCalls[0].headers["X-MOVP-Hybrid-Signature"], undefined);

  const sessBody = JSON.parse(fetchCalls[1].body);
  assert.deepEqual(Object.keys(sessBody), ["schemaVersion", "publicKeySpki", "challenge", "deviceId", "signature"]);
  assert.equal(sessBody.publicKeySpki, identity.spkiB64);
  assert.equal(sessBody.challenge, responses.challenge.challenge, "uses the JWT, not attestationChallenge");
  assert.equal(sessBody.deviceId, identity.deviceId);
  assert.ok(verifies(`MOVP-HYBRID-SESSION-V1\n${responses.challenge.challenge}\n${identity.deviceId}`, sessBody.signature));
  assert.equal(fetchCalls[1].headers["X-MOVP-Hybrid-Signature"], undefined);

  assert.equal(fetchCalls[2].body, `{"schemaVersion":1,"deviceId":"${identity.deviceId}","channel":"prod","settingsProfile":7}`);
  assert.equal(fetchCalls[3].body,
    `{"schemaVersion":1,"deviceId":"${identity.deviceId}","action":"guest","payload":{"deviceKey":"${identity.deviceId}","appVersion":"17.4","platform":"android"}}`);
  for (const c of fetchCalls.slice(2)) {
    assert.equal(c.headers["X-MOVP-Hybrid-Session"], "tok-1");
    assert.ok(c.headers["X-MOVP-Hybrid-Signature"]);
  }

  assert.equal(s.sessionToken, "tok-1");
  assert.equal(s.deviceId, identity.deviceId);
  assert.ok(s.grants.catalog);
  assert.ok(s.grants["catalog-value"]);
  assert.ok(s.grants.bootstrap, "bootstrap-only grant kept by the merge");
  assert.ok(s.grants["download-control"]);
});

test("ensureSession: merges grants from bootstrap AND auth (each holds one the other lacks)", async () => {
  const base = handshakeServer();
  fetchHandler = (c) => {
    const path = c.url.slice(API.length);
    if (path === "/v2/client/bootstrap") {
      return { body: { ...responses.bootstrap, admission: { ...responses.bootstrap.admission, grants: { bootstrap: "g-b", catalog: "g-cat" } } } };
    }
    if (path === "/v2/client/auth") {
      return { body: { ...responses.auth, admission: { ...responses.auth.admission, grants: { "catalog-value": "g-val", "download-control": "g-dl" } } } };
    }
    return base(c);
  };
  const s = await ensureSession();
  assert.deepEqual(s.grants, { bootstrap: "g-b", catalog: "g-cat", "catalog-value": "g-val", "download-control": "g-dl" });
});

test("ensureSession: reuses a valid stored session without any request", async () => {
  fetchHandler = handshakeServer();
  const a = await ensureSession();
  fetchCalls = [];
  const b = await ensureSession();
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(b, a);
});

test("ensureSession: an expired stored session triggers a new handshake", async () => {
  fetchHandler = handshakeServer();
  await ensureSession();
  const key = "movp:session:v1";
  const saved = JSON.parse(store.get(key));
  saved.expiresAtMs = Date.now() - 1000;
  store.set(key, JSON.stringify(saved));
  fetchCalls = [];
  const s = await ensureSession();
  assert.equal(fetchCalls.length, 4);
  assert.equal(s.sessionToken, "tok-2");
});

test("ensureSession: fails clearly when the grants never arrive", async () => {
  const base = handshakeServer();
  fetchHandler = (c) => {
    const r = base(c);
    if (c.url.endsWith("/bootstrap") || c.url.endsWith("/auth")) return { body: { ok: false } };
    return r;
  };
  await assert.rejects(() => ensureSession(), (e) => e.code === "unavailable" && /grants/.test(e.message));
  assert.equal([...store.keys()].some((k) => k !== "movp:identity:v1" && k !== "movp:recipe:v1"), false, "no session persisted on failure");
});

test("call: ensureSession + signed request, returns the parsed response", async () => {
  fetchHandler = handshakeServer();
  const r = await call("/v2/client/movie-variants", { id: 1 });
  assert.deepEqual(r, { ok: true, echo: "/v2/client/movie-variants" });
  const last = fetchCalls.at(-1);
  assert.equal(last.headers["X-MOVP-Hybrid-Session"], "tok-1");
  assert.equal(last.body, '{"id":1}');
});

test("call: on 401 re-does the handshake once and retries (ensureSession ran twice)", async () => {
  let rejected = 0;
  fetchHandler = handshakeServer({
    reject401: (c, path) => {
      if (path === "/v2/client/movie-variants" && c.headers["X-MOVP-Hybrid-Session"] === "tok-1") { rejected++; return true; }
      return false;
    },
  });
  const r = await call("/v2/client/movie-variants", { id: 7 });

  assert.equal(rejected, 1);
  assert.deepEqual(r, { ok: true, echo: "/v2/client/movie-variants" });
  const handshakes = fetchCalls.filter((c) => c.url.endsWith("/v2/client/challenge")).length;
  assert.equal(handshakes, 2, "initial handshake + one re-session");
  const calls = fetchCalls.filter((c) => c.url.endsWith("/v2/client/movie-variants"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["X-MOVP-Hybrid-Session"], "tok-1");
  assert.equal(calls[1].headers["X-MOVP-Hybrid-Session"], "tok-2");
  const saved = JSON.parse(store.get("movp:session:v1"));
  assert.equal(saved.sessionToken, "tok-2", "the renewed session is the persisted one");
});

test("call: a second 401 is not retried again", async () => {
  fetchHandler = handshakeServer({ reject401: (c, path) => path === "/v2/client/movie-variants" });
  await assert.rejects(() => call("/v2/client/movie-variants", {}), (e) => e.status === 401);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/v2/client/movie-variants")).length, 2);
});

test("call: non-session errors (500) are not retried", async () => {
  const base = handshakeServer();
  fetchHandler = (c) => (c.url.endsWith("/boom") ? { status: 500, body: { ok: false } } : base(c));
  await assert.rejects(() => call("/boom", {}), (e) => e.status === 500);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/boom")).length, 1);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/challenge")).length, 1);
});
