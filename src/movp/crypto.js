// RSA-2048 identity for the Movie+ anonymous session: keygen, SPKI/installationId and PKCS#1 v1.5 SHA-256 signing.
// Kino has no native RSA, so signing is EMSA-PKCS1-v1_5 built by hand over kino.crypto.hash and kino.crypto.modPow.
// Primitives are read from globalThis.kino at call time, so the same code runs in Kino and under node --test with a shim.

const SHA256_DIGESTINFO_HEX = "3031300d060960864801650304020105000420";
const RSA_ENCRYPTION_ALGID_HEX = "300d06092a864886f70d0101010500";
const PUBLIC_EXPONENT = 65537;
const KEY_BITS = 2048;
const MILLER_RABIN_ROUNDS = 10;
const STORAGE_KEY = "movp:identity:v1";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const getKino = () => globalThis.kino;

export function sha256hex(input, inputEncoding = "utf8") {
  return getKino().crypto.hash("sha256", input, { inputEncoding, outputEncoding: "hex" });
}

function hexToBase64(hex) {
  let out = "";
  for (let i = 0; i < hex.length; i += 6) {
    const chunk = hex.slice(i, i + 6);
    const bytes = chunk.length / 2;
    const v = parseInt(chunk.padEnd(6, "0"), 16);
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    out += bytes > 1 ? B64[(v >> 6) & 63] : "=";
    out += bytes > 2 ? B64[v & 63] : "=";
  }
  return out;
}

function utf8Hex(str) {
  const bytes = unescape(encodeURIComponent(str));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

const toHex = (big) => {
  const h = big.toString(16);
  return h.length % 2 ? "0" + h : h;
};
const fromHex = (hex) => BigInt("0x" + hex);

function modPow(base, exp, mod) {
  return fromHex(getKino().crypto.modPow(toHex(base), toHex(exp), toHex(mod)));
}

export function signPkcs1(identity, message) {
  const n = identity.n;
  const klen = Math.ceil(n.length / 2);
  const hashHex = sha256hex(utf8Hex(message), "hex");
  const t = SHA256_DIGESTINFO_HEX + hashHex;
  const padLen = klen - t.length / 2 - 3;
  if (padLen < 8) throw getKino().error("invalid_request", "RSA key too small for SHA-256");
  const em = "0001" + "ff".repeat(padLen) + "00" + t;
  const sigHex = getKino().crypto.modPow(em, identity.d, n);
  return hexToBase64(sigHex.padStart(klen * 2, "0"));
}

function derLength(len) {
  if (len < 0x80) return len.toString(16).padStart(2, "0");
  const h = toHex(BigInt(len));
  return (0x80 + h.length / 2).toString(16) + h;
}

const der = (tag, bodyHex) => tag + derLength(bodyHex.length / 2) + bodyHex;

function derInteger(hex) {
  let h = hex.replace(/^(00)+(?=..)/, "");
  if (parseInt(h.slice(0, 2), 16) >= 0x80) h = "00" + h;
  return der("02", h);
}

export function buildSpkiB64(nHex, e) {
  const rsaPublicKey = der("30", derInteger(nHex) + derInteger(toHex(BigInt(e))));
  const bitString = der("03", "00" + rsaPublicKey);
  return hexToBase64(der("30", RSA_ENCRYPTION_ALGID_HEX + bitString));
}

const SMALL_PRIMES = (() => {
  const out = [];
  for (let i = 3; i < 2000; i += 2) {
    let prime = true;
    for (let j = 0; out[j] * out[j] <= i; j++) if (i % out[j] === 0) { prime = false; break; }
    if (prime) out.push(i);
  }
  return out;
})();

const randomBig = (bytes) => fromHex(getKino().crypto.randomBytes(bytes, "hex"));

function randomBelow(max) {
  const bytes = Math.ceil(max.toString(16).length / 2) + 8;
  return (randomBig(bytes) % (max - 3n)) + 2n;
}

function isProbablePrime(n) {
  for (const p of SMALL_PRIMES) {
    const bp = BigInt(p);
    if (n === bp) return true;
    if (n % bp === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  const nMinus1 = n - 1n;
  for (let round = 0; round < MILLER_RABIN_ROUNDS; round++) {
    const a = round === 0 ? 2n : randomBelow(nMinus1);
    let x = modPow(a, d, n);
    if (x === 1n || x === nMinus1) continue;
    let composite = true;
    for (let r = 1; r < s; r++) {
      x = (x * x) % n;
      if (x === nMinus1) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}

function generatePrime(bits) {
  const bytes = bits / 8;
  const e = BigInt(PUBLIC_EXPONENT);
  for (;;) {
    // top two bits set so p*q has exactly 2*bits bits; low bit set so it is odd
    const candidate = randomBig(bytes) | (3n << BigInt(bits - 2)) | 1n;
    if ((candidate - 1n) % e === 0n) continue;
    if (isProbablePrime(candidate)) return candidate;
  }
}

function modInverse(a, m) {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

export function generateIdentity() {
  const e = BigInt(PUBLIC_EXPONENT);
  let p, q, n;
  do {
    p = generatePrime(KEY_BITS / 2);
    q = generatePrime(KEY_BITS / 2);
    n = p * q;
  } while (p === q || n.toString(2).length !== KEY_BITS);
  const d = modInverse(e, (p - 1n) * (q - 1n));
  const nHex = toHex(n);
  const spkiB64 = buildSpkiB64(nHex, PUBLIC_EXPONENT);
  const spkiHex = Array.from(atobHexBytes(spkiB64), (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    n: nHex,
    e: PUBLIC_EXPONENT,
    d: toHex(d),
    spkiB64,
    installationId: "install_" + sha256hex(spkiHex, "hex"),
    deviceId: getKino().crypto.uuid(),
  };
}

function atobHexBytes(b64) {
  const bytes = [];
  let bits = 0, acc = 0;
  for (const ch of b64) {
    if (ch === "=") break;
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  return bytes;
}

export function getIdentity() {
  const storage = getKino().storage;
  try {
    const saved = JSON.parse(storage.get(STORAGE_KEY) || "null");
    if (saved && saved.n && saved.d && saved.spkiB64 && saved.installationId && saved.deviceId) return saved;
  } catch (_) { /* unreadable copy: generate a new identity */ }
  const identity = generateIdentity();
  storage.set(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
