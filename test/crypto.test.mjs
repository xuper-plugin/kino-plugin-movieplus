import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/rsa-vectors.json", import.meta.url), "utf8"));

// Node stand-in for the Kino primitives the module detects at call time.
const store = new Map();
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
};

const { sha256hex, signPkcs1, generateIdentity, getIdentity } = await import("../src/movp/crypto.js");

const goldenIdentity = {
  n: vectors.key.n_hex,
  e: vectors.key.e,
  d: vectors.key.d_hex,
};

test("sha256hex matches the golden examples", () => {
  for (const ex of vectors.sha256_examples) assert.equal(sha256hex(ex.in), ex.hex);
});

test("sha256hex hashes hex-encoded bytes", () => {
  assert.equal(sha256hex("686f6c61", "hex"), vectors.sha256_examples.find((x) => x.in === "hola").hex);
});

test("signPkcs1 reproduces every golden signature", () => {
  assert.ok(vectors.vectors.length > 0);
  for (const v of vectors.vectors) {
    assert.equal(signPkcs1(goldenIdentity, v.message), v.sig_b64, `message: ${v.message}`);
  }
});

test("signPkcs1 output verifies with Node's RSA-SHA256", async () => {
  const { createVerify } = await import("node:crypto");
  const pub = createPublicKey({ key: Buffer.from(vectors.key.spki_b64, "base64"), format: "der", type: "spki" });
  const sig = signPkcs1(goldenIdentity, "otro mensaje ñ ✓");
  assert.ok(createVerify("RSA-SHA256").update("otro mensaje ñ ✓").verify(pub, Buffer.from(sig, "base64")));
});

test("generateIdentity: 2048-bit key, SPKI and installationId are consistent", () => {
  const id = generateIdentity();
  assert.equal(BigInt("0x" + id.n).toString(2).length, 2048);
  assert.equal(id.e, 65537);
  const spki = Buffer.from(id.spkiB64, "base64");
  assert.equal(id.installationId, "install_" + createHash("sha256").update(spki).digest("hex"));
  assert.equal(id.installationId.slice(8), sha256hex(spki.toString("hex"), "hex"));
  assert.match(id.deviceId, /^[0-9a-f-]{36}$/);

  // Node parses our hand-built SPKI and sees the same modulus.
  const jwk = createPublicKey({ key: spki, format: "der", type: "spki" }).export({ format: "jwk" });
  assert.equal(BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex")), BigInt("0x" + id.n));
});

test("generated key signs verifiably", async () => {
  const { createVerify } = await import("node:crypto");
  const id = generateIdentity();
  const pub = createPublicKey({ key: Buffer.from(id.spkiB64, "base64"), format: "der", type: "spki" });
  const sig = signPkcs1(id, "MOVP-HYBRID-SESSION-V1\nabc\ndev");
  assert.ok(createVerify("RSA-SHA256").update("MOVP-HYBRID-SESSION-V1\nabc\ndev").verify(pub, Buffer.from(sig, "base64")));
});

test("SPKI builder reproduces the golden SPKI for the fixed key", async () => {
  const mod = await import("../src/movp/crypto.js");
  assert.equal(mod.buildSpkiB64(goldenIdentity.n, goldenIdentity.e), vectors.key.spki_b64);
  assert.equal(
    "install_" + sha256hex(Buffer.from(vectors.key.spki_b64, "base64").toString("hex"), "hex"),
    vectors.installationId,
  );
});

test("getIdentity generates once and caches in kino.storage", () => {
  store.clear();
  let gens = 0;
  const origUuid = globalThis.kino.crypto.uuid;
  globalThis.kino.crypto.uuid = () => { gens++; return origUuid(); };
  const a = getIdentity();
  const b = getIdentity();
  assert.equal(gens, 1);
  assert.deepEqual(a, b);
  assert.ok(store.size >= 1);
  globalThis.kino.crypto.uuid = origUuid;
});
