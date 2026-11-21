// src/movp/inflate.js
var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function buildTable(lengths, n) {
  const count = new Array(16).fill(0);
  let max = 0;
  for (let i = 0; i < n; i++) {
    count[lengths[i]]++;
    if (lengths[i] > max) max = lengths[i];
  }
  count[0] = 0;
  if (max === 0) return { table: new Int32Array(2), bits: 1 };
  const next = new Array(17).fill(0);
  let code = 0;
  for (let l = 1; l <= 15; l++) {
    code = code + count[l - 1] << 1;
    next[l] = code;
  }
  const size = 1 << max;
  const table = new Int32Array(size);
  for (let sym = 0; sym < n; sym++) {
    const l = lengths[sym];
    if (!l) continue;
    const c = next[l]++;
    let rev = 0;
    for (let b = 0; b < l; b++) rev |= (c >> b & 1) << l - 1 - b;
    for (let i = rev; i < size; i += 1 << l) table[i] = l << 16 | sym;
  }
  return { table, bits: max };
}
var fixedTables = null;
function fixed() {
  if (!fixedTables) {
    const l = new Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    fixedTables = { lit: buildTable(l, 288), dist: buildTable(new Array(30).fill(5), 30) };
  }
  return fixedTables;
}
function gunzipBytes(src) {
  const n = src.length;
  if (n < 18 || src[0] !== 31 || src[1] !== 139 || src[2] !== 8) throw new Error("not a gzip stream");
  const flags = src[3];
  let pos = 10;
  if (flags & 4) pos += 2 + (src[pos] | src[pos + 1] << 8);
  if (flags & 8) {
    while (src[pos++] !== 0) ;
  }
  if (flags & 16) {
    while (src[pos++] !== 0) ;
  }
  if (flags & 2) pos += 2;
  const isize = (src[n - 4] | src[n - 3] << 8 | src[n - 2] << 16 | src[n - 1] << 24) >>> 0;
  const out = new Uint8Array(isize);
  let op = 0;
  let buf = 0;
  let cnt = 0;
  const bits = (need) => {
    while (cnt < need) {
      buf |= (pos < n ? src[pos] : 0) << cnt;
      pos++;
      cnt += 8;
    }
    const v = buf & (1 << need) - 1;
    buf >>>= need;
    cnt -= need;
    return v;
  };
  const decode = (t2) => {
    while (cnt < t2.bits) {
      buf |= (pos < n ? src[pos] : 0) << cnt;
      pos++;
      cnt += 8;
    }
    const e = t2.table[buf & (1 << t2.bits) - 1];
    const len = e >> 16;
    if (!len) throw new Error("invalid huffman code");
    buf >>>= len;
    cnt -= len;
    return e & 65535;
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      cnt -= cnt & 7;
      buf = 0;
      pos -= cnt >> 3;
      cnt = 0;
      const len = src[pos] | src[pos + 1] << 8;
      pos += 4;
      if (op + len > isize || pos + len > n) throw new Error("corrupt stored block");
      out.set(src.subarray(pos, pos + len), op);
      pos += len;
      op += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      ({ lit, dist } = fixed());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clt = buildTable(cl, 19);
      const lens = new Array(hlit + hdist).fill(0);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(clt);
        if (sym < 16) {
          lens[i++] = sym;
          continue;
        }
        let rep, val = 0;
        if (sym === 16) {
          if (!i) throw new Error("corrupt code lengths");
          val = lens[i - 1];
          rep = 3 + bits(2);
        } else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > hlit + hdist) throw new Error("corrupt code lengths");
        while (rep--) lens[i++] = val;
      }
      lit = buildTable(lens.slice(0, hlit), hlit);
      dist = buildTable(lens.slice(hlit), hdist);
    } else {
      throw new Error("invalid deflate block");
    }
    for (; ; ) {
      const sym = decode(lit);
      if (sym < 256) {
        if (op >= isize) throw new Error("gzip output overrun");
        out[op++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error("invalid length code");
        const len = LBASE[li] + bits(LEXT[li]);
        const di = decode(dist);
        if (di >= 30) throw new Error("invalid distance code");
        const d = DBASE[di] + bits(DEXT[di]);
        if (d > op || op + len > isize) throw new Error("invalid match");
        for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
      }
    }
  }
  if (op !== isize) throw new Error("gzip size mismatch");
  return out;
}
function gunzipBase64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(gunzipBytes(bytes));
}

// src/movp/stream.js
function arrayStart(text2, key) {
  const needle = '"' + key + '"';
  let k = text2.indexOf(needle);
  while (k >= 0) {
    let j = k + needle.length;
    while (j < text2.length && text2.charCodeAt(j) <= 32) j++;
    if (text2[j] === ":") {
      const b = text2.indexOf("[", j);
      return b < 0 ? -1 : b + 1;
    }
    k = text2.indexOf(needle, k + needle.length);
  }
  return -1;
}
function scanElements(text2, offset, max) {
  const elems = [];
  const n = text2.length;
  let i = offset, depth = 0, inStr = false, esc = false, start = -1;
  for (; i < n; i++) {
    const ch = text2[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (start < 0) start = i;
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (start < 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (ch === "]") {
      if (depth === 0) {
        if (start >= 0) elems.push(text2.slice(start, i).trim());
        return { elems, next: i + 1, done: true };
      }
      depth--;
      continue;
    }
    if (depth === 0 && ch === ",") {
      if (start >= 0) {
        elems.push(text2.slice(start, i).trim());
        start = -1;
      }
      if (elems.length >= max) return { elems, next: i + 1, done: false };
      continue;
    }
    if (start < 0 && text2.charCodeAt(i) > 32) start = i;
  }
  if (start >= 0) elems.push(text2.slice(start, i).trim());
  return { elems, next: i, done: true };
}
function countArray(text2, key) {
  const start = arrayStart(text2, key);
  if (start < 0) return 0;
  const n = text2.length;
  let i = start, depth = 0, inStr = false, esc = false, count = 0, seen = false;
  for (; i < n; i++) {
    const ch = text2[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      seen = true;
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      seen = true;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (ch === "]") {
      if (depth === 0) return seen ? count + 1 : count;
      depth--;
      continue;
    }
    if (depth === 0 && ch === ",") {
      count++;
      seen = false;
      continue;
    }
    if (!seen && text2.charCodeAt(i) > 32) seen = true;
  }
  return seen ? count + 1 : count;
}

// src/movp/catalog.js
var CATALOG_URLS = [
  "https://raw.githubusercontent.com/dev-mplus01/mplus01T/main/db/items.json.gz",
  "https://appsdevxp.com/app/db/items.json.gz",
  "https://developerxploit.com/app/db/items.json.gz"
];
var FETCH_TIMEOUT_MS = 3e4;
var UPSERT_MAX = 500;
var RECENT_PER_CATEGORY = 200;
var SCAN_PAGE = 100;
var SCAN_MAX_PAGES = 30;
var BROWSE_SCAN_PAGES = 10;
var TITLE_MAX = 300;
var CURSOR_KEY = "movp:catalog:cursor:v1";
var DONE_KEY = "movp:catalog:v1";
var RECENT_KEY = "movp:catalog:recent:v1";
var CATEGORIES = [
  { key: "peliculas", label: "Pel\xEDculas", labelEn: "Movies", types: [1] },
  { key: "series", label: "Series", labelEn: "Series", types: [2] },
  { key: "animes", label: "Animes-Cartoons", labelEn: "Anime & Cartoons", types: [3, 4] },
  { key: "doramas", label: "Doramas", labelEn: "Doramas", types: [6] },
  { key: "duanju", label: "Duanju", labelEn: "Duanju", types: [7] },
  { key: "telenovelas", label: "Telenovelas", labelEn: "Telenovelas", types: [5] }
];
var getKino = () => globalThis.kino;
function typeToCategory(type) {
  const t2 = Number(type);
  const cat = CATEGORIES.find((c) => c.types.includes(t2));
  return cat ? cat.key : null;
}
function gunzipText(b64) {
  const k = getKino();
  if (k.crypto && typeof k.crypto.gunzip === "function") {
    try {
      const out2 = k.crypto.gunzip(b64);
      try {
        k.log && k.log(`native gunzip ok: ${out2.length} chars`);
      } catch (_) {
      }
      return out2;
    } catch (e) {
      try {
        k.log && k.log(`native gunzip failed (${e && (e.message || e.code) || e}); using JS inflate`);
      } catch (_) {
      }
    }
  }
  const t0 = Date.now();
  const out = gunzipBase64ToText(b64);
  try {
    k.log && k.log(`JS inflate ok: ${out.length} chars in ${Date.now() - t0} ms`);
  } catch (_) {
  }
  return out;
}
async function fetchCatalogText() {
  const k = getKino();
  let lastErr = null;
  for (const url of CATALOG_URLS) {
    try {
      const resp = await k.fetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text2 = gunzipText(resp.base64());
      if (arrayStart(text2, "movies") < 0 && arrayStart(text2, "series") < 0) throw new Error("unexpected catalog shape");
      try {
        k.log && k.log(`Movie+ catalog text ready from ${url}: ${text2.length} chars`);
      } catch (_) {
      }
      return text2;
    } catch (err) {
      lastErr = err;
      try {
        k.log && k.log(`catalog mirror failed ${url}: ${err && (err.message || err.code) || err}`);
      } catch (_) {
      }
    }
  }
  throw k.error("unavailable", `Movie+ catalog download failed${lastErr && lastErr.message ? ": " + lastErr.message : ""}`);
}
function countItemsText(text2) {
  return countArray(text2, "movies") + countArray(text2, "series");
}
var STREAM_SPECS = [
  { key: "movies", kind: "movie", type: 1 },
  { key: "series", kind: "series", type: 2 }
];
function insertTopN(list, item, n) {
  if (list.length < n) {
    list.push(item);
    return;
  }
  let mi = 0;
  for (let i = 1; i < list.length; i++) if (list[i].s < list[mi].s) mi = i;
  if (item.s > list[mi].s) list[mi] = item;
}
async function importTextTick(text2, cursor, batch) {
  const k = getKino();
  const max = Math.max(1, Math.min(UPSERT_MAX, Math.floor(Number(batch)) || UPSERT_MAX));
  let si = cursor && Number.isInteger(cursor.si) ? cursor.si : 0;
  let off = cursor && Number.isInteger(cursor.off) ? cursor.off : -1;
  let done = cursor && Number(cursor.done) || 0;
  let recent = cursor && cursor.recent;
  if (!recent) {
    recent = {};
    for (const c of CATEGORIES) recent[c.key] = [];
  }
  while (si < STREAM_SPECS.length && off < 0) {
    off = arrayStart(text2, STREAM_SPECS[si].key);
    if (off < 0) si++;
  }
  if (si >= STREAM_SPECS.length) return { si, off: -1, done, recent, finished: true };
  const spec = STREAM_SPECS[si];
  const { elems, next, done: arrDone } = scanElements(text2, off, max);
  const rows = [];
  let failed = 0;
  for (const e of elems) {
    let raw;
    try {
      raw = JSON.parse(e);
    } catch (_) {
      failed++;
      continue;
    }
    if (!raw || raw.id == null) continue;
    const item = toItem(raw, spec.kind, spec.type);
    const stored = toStored(item, /* @__PURE__ */ new Map([[item.id, raw.date]]));
    rows.push(stored);
    const list = recent[item.categoryKey];
    if (list) insertTopN(list, { id: item.id, s: stored.sort }, RECENT_PER_CATEGORY);
  }
  if (rows.length) await k.catalog.upsert(rows);
  done += elems.length;
  if (failed) {
    try {
      k.log && k.log(`Movie+ import: ${failed} of ${elems.length} ${spec.key} items failed to parse at offset ${off}`);
    } catch (_) {
    }
  }
  if (arrDone) {
    const nextSi = si + 1;
    return { si: nextSi, off: -1, done, recent, finished: nextSi >= STREAM_SPECS.length };
  }
  return { si, off: next, done, recent, finished: false };
}
function finishImport(recent, total) {
  const lists = {};
  for (const c of CATEGORIES) {
    const arr = recent && recent[c.key] || [];
    lists[c.key] = arr.slice().sort((a, b) => b.s - a.s).map((x) => x.id);
  }
  writeJson(RECENT_KEY, lists);
  writeJson(DONE_KEY, { at: Date.now(), total: Number(total) || 0 });
  getKino().storage.remove(CURSOR_KEY);
}
function yearOf(date) {
  const y = String(date || "").slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "";
}
function genresOf(raw) {
  return String(raw || "").split(",").map((g) => g.trim()).filter(Boolean);
}
function toItem(raw, kind, defaultType) {
  const type = Number(raw.type) || defaultType;
  return {
    id: (kind === "movie" ? "m:" : "s:") + raw.id,
    kind,
    type,
    title: String(raw.nameFile || ""),
    year: yearOf(raw.date),
    poster: String(raw.urlImage || ""),
    genres: genresOf(raw.generos),
    categoryKey: typeToCategory(type)
  };
}
function sortOf(item, dates) {
  const t2 = Date.parse(dates.get(item.id) || "");
  return Number.isSafeInteger(t2) ? t2 : 0;
}
function toStored(item, dates) {
  const title = (item.title || `Movie+ ${item.id}`).slice(0, TITLE_MAX).replace(/[\uD800-\uDBFF]$/, "");
  return {
    id: item.id,
    title,
    sort: sortOf(item, dates),
    data: { k: item.kind, t: item.type, y: item.year, p: item.poster, g: item.genres.join(",") }
  };
}
function fromStored(row) {
  const d = row.data || {};
  const type = Number(d.t) || (d.k === "movie" ? 1 : 2);
  return {
    id: row.id,
    kind: d.k === "movie" ? "movie" : "series",
    type,
    title: row.title,
    year: d.y || "",
    poster: d.p || "",
    genres: genresOf(d.g),
    categoryKey: typeToCategory(type)
  };
}
function readJson(key) {
  try {
    return JSON.parse(getKino().storage.get(key) || "null");
  } catch (_) {
    return null;
  }
}
function writeJson(key, value) {
  try {
    getKino().storage.set(key, JSON.stringify(value));
  } catch (_) {
  }
}
async function getAll(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += UPSERT_MAX) out.push(...await getKino().catalog.get(ids.slice(i, i + UPSERT_MAX)));
  return out;
}
async function recentByCategory(categoryKey, limit = 30) {
  const n = Math.max(0, Math.floor(Number(limit)) || 0);
  const lists = readJson(RECENT_KEY);
  if (lists && Array.isArray(lists[categoryKey])) {
    return (await getAll(lists[categoryKey].slice(0, n))).map(fromStored);
  }
  const out = [];
  for (let page = 0; page < SCAN_MAX_PAGES && out.length < n; page++) {
    const res = await getKino().catalog.search({ limit: SCAN_PAGE, offset: page * SCAN_PAGE, order: "newest" });
    for (const row of res.items) {
      const item = fromStored(row);
      if (item.categoryKey === categoryKey && out.length < n) out.push(item);
    }
    if ((page + 1) * SCAN_PAGE >= res.total) break;
  }
  return out;
}
async function catalogCount() {
  return getKino().catalog.count();
}
async function isCatalogReady() {
  const k = getKino();
  if (!readJson(DONE_KEY)) return false;
  if (k.storage.get(CURSOR_KEY) != null) return false;
  return await k.catalog.count() > 0;
}
async function searchCatalog(query, limit = 50) {
  const q = String(query || "").trim().slice(0, 256);
  if (!q) return [];
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 50));
  const res = await getKino().catalog.search({ q, limit: n, order: "newest" });
  const needle = q.toLowerCase();
  const items = res.items.map(fromStored);
  const starts = (it) => it.title.toLowerCase().startsWith(needle) ? 0 : 1;
  return items.map((it, i) => ({ it, i })).sort((a, b) => starts(a.it) - starts(b.it) || a.i - b.i).map((x) => x.it);
}
async function browseCategory(categoryKey, { offset = 0, limit = 20, genre = "" } = {}) {
  const lists = readJson(RECENT_KEY);
  if (!genre && lists && Array.isArray(lists[categoryKey]) && lists[categoryKey].length === 0) return { items: [], next: null };
  const want = String(genre || "").toLowerCase();
  const items = [];
  let pos = Math.max(0, Math.floor(Number(offset)) || 0);
  for (let page = 0; page < BROWSE_SCAN_PAGES; page++) {
    const res = await getKino().catalog.search({ limit: SCAN_PAGE, offset: pos, order: "newest" });
    for (let i = 0; i < res.items.length; i++) {
      const item = fromStored(res.items[i]);
      if (item.categoryKey !== categoryKey) continue;
      if (want && !item.genres.some((g) => g.toLowerCase() === want)) continue;
      items.push(item);
      if (items.length >= limit) return { items, next: pos + i + 1 < res.total ? pos + i + 1 : null };
    }
    pos += res.items.length;
    if (!res.items.length || pos >= res.total) return { items, next: null };
  }
  return { items, next: items.length ? pos : null };
}

// src/movp/crypto.js
var SHA256_DIGESTINFO_HEX = "3031300d060960864801650304020105000420";
var RSA_ENCRYPTION_ALGID_HEX = "300d06092a864886f70d0101010500";
var PUBLIC_EXPONENT = 65537;
var KEY_BITS = 2048;
var MILLER_RABIN_ROUNDS = 10;
var STORAGE_KEY = "movp:identity:v1";
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var getKino2 = () => globalThis.kino;
function sha256hex(input, inputEncoding = "utf8") {
  return getKino2().crypto.hash("sha256", input, { inputEncoding, outputEncoding: "hex" });
}
function hexToBase64(hex) {
  let out = "";
  for (let i = 0; i < hex.length; i += 6) {
    const chunk = hex.slice(i, i + 6);
    const bytes = chunk.length / 2;
    const v = parseInt(chunk.padEnd(6, "0"), 16);
    out += B64[v >> 18 & 63] + B64[v >> 12 & 63];
    out += bytes > 1 ? B64[v >> 6 & 63] : "=";
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
var toHex = (big) => {
  const h = big.toString(16);
  return h.length % 2 ? "0" + h : h;
};
var fromHex = (hex) => BigInt("0x" + hex);
function modPow(base, exp, mod) {
  return fromHex(getKino2().crypto.modPow(toHex(base), toHex(exp), toHex(mod)));
}
function signPkcs1(identity, message) {
  const n = identity.n;
  const klen = Math.ceil(n.length / 2);
  const hashHex = sha256hex(utf8Hex(message), "hex");
  const t2 = SHA256_DIGESTINFO_HEX + hashHex;
  const padLen = klen - t2.length / 2 - 3;
  if (padLen < 8) throw getKino2().error("invalid_request", "RSA key too small for SHA-256");
  const em = "0001" + "ff".repeat(padLen) + "00" + t2;
  const sigHex = getKino2().crypto.modPow(em, identity.d, n);
  return hexToBase64(sigHex.padStart(klen * 2, "0"));
}
function derLength(len) {
  if (len < 128) return len.toString(16).padStart(2, "0");
  const h = toHex(BigInt(len));
  return (128 + h.length / 2).toString(16) + h;
}
var der = (tag, bodyHex) => tag + derLength(bodyHex.length / 2) + bodyHex;
function derInteger(hex) {
  let h = hex.replace(/^(00)+(?=..)/, "");
  if (parseInt(h.slice(0, 2), 16) >= 128) h = "00" + h;
  return der("02", h);
}
function buildSpkiB64(nHex, e) {
  const rsaPublicKey = der("30", derInteger(nHex) + derInteger(toHex(BigInt(e))));
  const bitString = der("03", "00" + rsaPublicKey);
  return hexToBase64(der("30", RSA_ENCRYPTION_ALGID_HEX + bitString));
}
var SMALL_PRIMES = (() => {
  const out = [];
  for (let i = 3; i < 2e3; i += 2) {
    let prime = true;
    for (let j = 0; out[j] * out[j] <= i; j++) if (i % out[j] === 0) {
      prime = false;
      break;
    }
    if (prime) out.push(i);
  }
  return out;
})();
var randomBig = (bytes) => fromHex(getKino2().crypto.randomBytes(bytes, "hex"));
function randomBelow(max) {
  const bytes = Math.ceil(max.toString(16).length / 2) + 8;
  return randomBig(bytes) % (max - 3n) + 2n;
}
function isProbablePrime(n) {
  for (const p of SMALL_PRIMES) {
    const bp = BigInt(p);
    if (n === bp) return true;
    if (n % bp === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  const nMinus1 = n - 1n;
  for (let round = 0; round < MILLER_RABIN_ROUNDS; round++) {
    const a = round === 0 ? 2n : randomBelow(nMinus1);
    let x = modPow(a, d, n);
    if (x === 1n || x === nMinus1) continue;
    let composite = true;
    for (let r = 1; r < s; r++) {
      x = x * x % n;
      if (x === nMinus1) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}
function generatePrime(bits) {
  const bytes = bits / 8;
  const e = BigInt(PUBLIC_EXPONENT);
  for (; ; ) {
    const candidate = randomBig(bytes) | 3n << BigInt(bits - 2) | 1n;
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
  return (oldS % m + m) % m;
}
function generateIdentity() {
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
    deviceId: getKino2().crypto.uuid()
  };
}
function atobHexBytes(b64) {
  const bytes = [];
  let bits = 0, acc = 0;
  for (const ch of b64) {
    if (ch === "=") break;
    acc = acc << 6 | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(acc >> bits & 255);
    }
  }
  return bytes;
}
function getIdentity() {
  const storage = getKino2().storage;
  try {
    const saved = JSON.parse(storage.get(STORAGE_KEY) || "null");
    if (saved && saved.n && saved.d && saved.spkiB64 && saved.installationId && saved.deviceId) return saved;
  } catch (_) {
  }
  const identity = generateIdentity();
  storage.set(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

// src/movp/vault.js
var VAULT_BASE = "https://secrets.kinoverse.app";
var OWNER = "xuper-plugin";
var REPO = "kino-plugin-movieplus";
var PLUGIN_ID = "movieplus";
var RECIPE_KEY = "movp:recipe:v1";
var TTL_MS = 60 * 60 * 1e3;
var REQUIRED = ["apiBase", "appVersion", "versionCode", "channel", "settingsProfile", "reqPrefix", "sessionPrefix"];
var getKino3 = () => globalThis.kino;
function valid(r) {
  return !!r && typeof r === "object" && REQUIRED.every((k) => r[k] != null) && /^https:\/\//.test(String(r.apiBase));
}
function cached() {
  try {
    const raw = getKino3().storage.get(RECIPE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && Number(o.at) && Date.now() - Number(o.at) < TTL_MS && valid(o.recipe)) return o.recipe;
  } catch (_) {
  }
  return null;
}
function recipe() {
  const r = cached();
  if (!r) throw getKino3().error("recipe_unavailable", "Abre Movie+ para activarlo y vuelve a intentarlo.");
  return r;
}
async function fetchChallenge() {
  const resp = await getKino3().fetch(VAULT_BASE + "/session/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (!resp.ok) throw getKino3().error("unavailable", `vault challenge HTTP ${resp.status}`);
  const data = resp.json();
  if (!data || !data.challenge) throw getKino3().error("unavailable", "vault challenge missing");
  return data.challenge;
}
async function ensureRecipe() {
  const have = cached();
  if (have) return have;
  const k = getKino3();
  const challenge = await fetchChallenge();
  try {
    k.log && k.log("Movie+ vault: challenge ok, calling kino.identity");
  } catch (_) {
  }
  let idp;
  try {
    idp = await k.identity.telegram({ challenge });
  } catch (e) {
    try {
      k.log && k.log("Movie+ vault: kino.identity threw code=" + (e && e.code || "?") + " msg=" + (e && e.message || e));
    } catch (_) {
    }
    throw e;
  }
  try {
    k.log && k.log("Movie+ vault: identity id=" + (idp && idp.id ? "yes" : "no") + " deviceKey=" + (idp && idp.deviceKey ? "yes" : "no") + " sig=" + (idp && idp.signature ? "yes" : "no") + " author=" + (idp && idp.author) + " codeHash=" + (idp && idp.codeHash ? "yes" : "no") + " token=" + (idp && idp.token ? "yes" : "no"));
  } catch (_) {
  }
  if (!idp || !idp.id || !idp.deviceKey || !idp.signature) throw k.error("unavailable", "kino.identity did not sign the vault challenge");
  const body = {
    pluginId: PLUGIN_ID,
    challenge,
    id: idp.id,
    deviceKey: idp.deviceKey,
    signature: idp.signature,
    author: idp.author,
    codeHash: idp.codeHash
  };
  if (idp.token) body.token = idp.token;
  const resp = await k.fetch(VAULT_BASE + `/secrets/${OWNER}/${REPO}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    k.log && k.log("Movie+ vault: POST /secrets -> " + resp.status);
  } catch (_) {
  }
  if (resp.status === 403) throw k.error("not_member", "Movie+ es para los miembros del grupo de Kino.");
  if (resp.status === 429) throw k.error("rate_limited", "Demasiadas solicitudes a Movie+; intenta en un momento.");
  if (!resp.ok) throw k.error("unavailable", `vault read HTTP ${resp.status}`);
  const data = resp.json();
  const r = data && data.secret;
  if (!valid(r)) throw k.error("unavailable", "the Movie+ recipe from the vault is invalid");
  try {
    k.storage.set(RECIPE_KEY, JSON.stringify({ at: Date.now(), recipe: r }));
  } catch (_) {
  }
  return r;
}

// src/movp/session.js
var STORAGE_KEY2 = "movp:session:v1";
var EXPIRY_MARGIN_MS = 3e4;
var DEFAULT_TTL_MS = 9 * 60 * 1e3;
var SESSION_ERROR = /session/i;
var getKino4 = () => globalThis.kino;
function httpError(message, status, extra) {
  const err = getKino4().error("unavailable", message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}
function parseBody(resp) {
  try {
    return resp.json();
  } catch (_) {
    return null;
  }
}
async function post(path, bodyObj, headers) {
  const resp = await getKino4().fetch(recipe().apiBase + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(bodyObj)
  });
  const data = parseBody(resp);
  const reason = data && (data.error || data.code);
  const sessionInvalid = resp.status === 401 || !!reason && typeof reason === "string" && SESSION_ERROR.test(reason);
  if (!resp.ok || data && data.ok === false && sessionInvalid) {
    throw httpError(`${path} failed (HTTP ${resp.status}${reason ? ", " + reason : ""})`, resp.status, { sessionInvalid });
  }
  return data === null ? {} : data;
}
async function signedFetch(path, bodyObj, sessionToken) {
  const token = sessionToken || readStored()?.sessionToken;
  if (!token) throw getKino4().error("invalid_request", "no Movie+ session token to sign with");
  const r = recipe();
  const body = JSON.stringify(bodyObj);
  const nonce = getKino4().crypto.uuid().replace(/-/g, "");
  const preimage = `${r.reqPrefix}
POST
${path}
${sha256hex(body)}
${nonce}
${sha256hex(token)}`;
  return post(path, bodyObj, {
    "X-MOVP-Hybrid-Session": token,
    "X-MOVP-Hybrid-Nonce": nonce,
    "X-MOVP-Hybrid-Signature": signPkcs1(getIdentity(), preimage),
    "X-MOVP-App-Version": r.appVersion,
    "X-MOVP-App-Version-Code": String(r.versionCode)
  });
}
function readStored() {
  try {
    const saved = JSON.parse(getKino4().storage.get(STORAGE_KEY2) || "null");
    if (saved && saved.sessionToken && saved.grants && saved.expiresAtMs) return saved;
  } catch (_) {
  }
  return null;
}
function clearStored() {
  getKino4().storage.remove(STORAGE_KEY2);
}
async function handshake() {
  const r = recipe();
  const id = getIdentity();
  const challenge = await post("/v2/client/challenge", { schemaVersion: 1, versionCode: r.versionCode });
  const jwt = challenge.challenge;
  if (!jwt) throw getKino4().error("unavailable", "Movie+ challenge missing");
  const session = await post("/v2/client/session", {
    schemaVersion: 1,
    publicKeySpki: id.spkiB64,
    challenge: jwt,
    deviceId: id.deviceId,
    signature: signPkcs1(id, `${r.sessionPrefix}
${jwt}
${id.deviceId}`)
  });
  const token = session.sessionToken;
  if (!token) throw getKino4().error("unavailable", "Movie+ session token missing");
  const grants = {};
  const bootstrap = await signedFetch("/v2/client/bootstrap", {
    schemaVersion: 1,
    deviceId: id.deviceId,
    channel: r.channel,
    settingsProfile: r.settingsProfile
  }, token);
  Object.assign(grants, bootstrap.admission && bootstrap.admission.grants || bootstrap.grants || {});
  const auth = await signedFetch("/v2/client/auth", {
    schemaVersion: 1,
    deviceId: id.deviceId,
    action: "guest",
    payload: { deviceKey: id.deviceId, appVersion: r.appVersion, platform: "android" }
  }, token);
  Object.assign(grants, auth.admission && auth.admission.grants || {});
  if (!grants.catalog || !grants["catalog-value"]) {
    throw getKino4().error("unavailable", "Movie+ did not return the catalog grants");
  }
  const ttl = session.expiresAtMs && session.serverNowMs ? session.expiresAtMs - session.serverNowMs : DEFAULT_TTL_MS;
  const saved = { sessionToken: token, grants, deviceId: id.deviceId, expiresAtMs: Date.now() + ttl };
  getKino4().storage.set(STORAGE_KEY2, JSON.stringify(saved));
  return saved;
}
async function ensureSession() {
  let s = readStored();
  if (!s || s.expiresAtMs - EXPIRY_MARGIN_MS <= Date.now()) s = await handshake();
  return { sessionToken: s.sessionToken, grants: s.grants, deviceId: s.deviceId };
}
async function call(path, bodyObj) {
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

// src/movp/resolve.js
var SCHEMA_VERSION = 1;
var VARIANT_SEP = ",_,";
var EPISODE_SEP = "_SPLIT_";
var FOLDER_SEP = "_FOLDER_";
var TOKEN_PREFIX = "Movp2!::";
var SERIES_ID = /^[1-9][0-9]{0,9}$/;
var EPISODE_CODE = /S(\d+)E(\d+)/i;
var SEASON_KEY = /Temporada\s*(\d+)/i;
var getKino5 = () => globalThis.kino;
function fail(code, message, userMessage) {
  return getKino5().error(code, message, userMessage ? { userMessage } : void 0);
}
function grant(session, name) {
  const id = session.grants && session.grants[name];
  if (!id) throw fail("unavailable", `Movie+ session has no ${name} grant`);
  return id;
}
function qualityRank(quality) {
  const q = String(quality).toLowerCase();
  if (/4k|uhd/.test(q)) return 2160;
  const m = q.match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}
var byQualityDesc = (a, b) => qualityRank(b.quality) - qualityRank(a.quality);
async function movieStreams(movieId) {
  const id = /^\d+$/.test(String(movieId)) ? Number(movieId) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw fail("invalid_request", `bad movie id: ${movieId}`);
  const s = await ensureSession();
  const resp = await call("/v2/client/movie-variants", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog"),
    movieId: id
  });
  const raw = resp && resp.movieLinks && resp.movieLinks.variants || [];
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
    throw fail("not_found", `no variants for movie ${id}`, "Esta pel\xEDcula no tiene enlaces disponibles ahora.");
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
async function seriesDocument(seriesId) {
  const docId = String(seriesId);
  if (!SERIES_ID.test(docId)) throw fail("invalid_request", `bad series id: ${seriesId}`);
  const s = await ensureSession();
  const resp = await call("/v2/client/document", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog"),
    collection: "tv",
    documentId: docId,
    minVersion: 0,
    freshRequest: getKino5().crypto.uuid()
  });
  const data = resp && resp.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw fail("not_found", `no episode document for series ${docId}`, "Esta serie no tiene episodios disponibles ahora.");
  }
  const bySeason = /* @__PURE__ */ new Map();
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
      if (!bySeason.has(p.s)) bySeason.set(p.s, /* @__PURE__ */ new Map());
      const episodes2 = bySeason.get(p.s);
      if (!episodes2.has(p.e)) episodes2.set(p.e, []);
      const variants = episodes2.get(p.e);
      if (!variants.some((v) => v.quality === quality)) variants.push({ quality, token: p.token, size: p.size, name: p.name });
    }
  }
  const seasons = /* @__PURE__ */ new Map();
  for (const num of [...bySeason.keys()].sort((a, b) => a - b)) {
    const episodes2 = bySeason.get(num);
    seasons.set(num, [...episodes2.keys()].sort((a, b) => a - b).map((e) => {
      const variants = episodes2.get(e).sort(byQualityDesc);
      const best = variants[0];
      return { s: num, e, name: best.name, token: best.token, size: best.size, quality: best.quality, variants };
    }));
  }
  if (!seasons.size) {
    throw fail("not_found", `no episodes in document for series ${docId}`, "Esta serie no tiene episodios disponibles ahora.");
  }
  return { seasons };
}
async function resolveToken(token, resolveProvider = true) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    throw fail("invalid_request", "bad Movie+ playback token");
  }
  const s = await ensureSession();
  const resp = await call("/v2/client/playback", {
    schemaVersion: SCHEMA_VERSION,
    deviceId: s.deviceId,
    grantId: grant(s, "catalog-value"),
    token,
    issuedAtMs: Math.floor(Date.now() / 1e3) * 1e3 - 1e3,
    resolveProvider: !!resolveProvider
  });
  if (!resp || resp.status !== "resolved" || !resp.value) {
    throw fail(
      "unavailable",
      `playback not resolved (status ${resp && resp.status ? resp.status : "missing"})`,
      "No se pudo obtener el enlace de reproducci\xF3n. Prueba de nuevo o elige otra calidad."
    );
  }
  return resp.value;
}

// src/contract/index.js
var getKino6 = () => globalThis.kino;
var IMG = "https://image.tmdb.org/t/p/";
var PAGE = 20;
var HOME_ROW = 20;
var SEARCH_MAX = 50;
var DEFAULT_CAP = 1080;
var GENRE_OF = { peliculas: "peliculas", series: "series", animes: "anime", doramas: "series", telenovelas: "series", duanju: "series" };
var isEn = () => getKino6().lang === "en";
var text = (es, en) => isEn() ? en : es;
var tmdbLang = () => isEn() ? "en-US" : "es-MX";
var img = (size, p) => {
  if (!p) return void 0;
  return /^https?:\/\//.test(p) ? p : IMG + size + p;
};
var yearOf2 = (d) => typeof d === "string" && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : void 0;
var rounded = (v) => v ? Math.round(v * 10) / 10 : void 0;
function notFound(message) {
  return getKino6().error("not_found", message, { userMessage: text("No se encontr\xF3 este t\xEDtulo.", "Title not found.") });
}
async function tmdb(path, params = {}) {
  const k = getKino6();
  try {
    return await k.tmdb(path, { language: tmdbLang(), ...params });
  } catch (e) {
    if (e && e.code === "not_found") throw notFound("tmdb 404 " + path);
    if (e && e.userMessage) throw e;
    throw k.error("unavailable", `tmdb ${path} ${e && e.code}`, {
      userMessage: text("No se pudo cargar la informaci\xF3n del t\xEDtulo.", "Could not load the title's information.")
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
function card(item) {
  const prefix = item.kind === "movie" ? "m" : "s";
  const tmdbId = Number(item.id.slice(2));
  return {
    id: prefix + tmdbId,
    ref: `${prefix}:${tmdbId}`,
    title: item.title,
    kind: item.kind,
    year: item.year ? Number(item.year) : void 0,
    poster: img("w342", item.poster),
    genres: item.genres.length ? item.genres.slice(0, 5) : void 0,
    ids: { tmdb: tmdbId }
  };
}
async function search(query) {
  const q = typeof query === "string" ? query : query && query.q || "";
  if (!String(q).trim()) return [];
  return (await searchCatalog(q, SEARCH_MAX)).map(card);
}
async function home() {
  if (!await isCatalogReady()) return [];
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
      genre: GENRE_OF[c.key]
    });
  });
  return rows;
}
async function browse(ref, cursor) {
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
    overview: d.overview || void 0,
    genres: (d.genres || []).map((g) => g.name).slice(0, 5),
    year: yearOf2(tv ? d.first_air_date : d.release_date),
    rating: rounded(d.vote_average),
    ids: { tmdb: d.id }
  };
}
async function details(ref) {
  const p = parseRef(ref);
  if (!p || p.kind === "episode") return null;
  if (p.kind === "series") return infoOf(await tmdb("/tv/" + p.id), true);
  const d = await tmdb("/movie/" + p.id);
  return { ...infoOf(d, false), runtimeMinutes: d.runtime > 0 ? d.runtime : void 0 };
}
async function seasonInfo(id, seasons) {
  const info = /* @__PURE__ */ new Map();
  let show = null;
  try {
    const groups = [];
    for (let i = 0; i < seasons.length; i += 19) groups.push(seasons.slice(i, i + 19));
    const blocks = await Promise.all(groups.map((g) => tmdb("/tv/" + id, { append_to_response: g.map((s) => "season/" + s).join(",") })));
    show = blocks[0] || null;
    blocks.forEach((b, bi) => {
      for (const s of groups[bi]) {
        for (const ep of b["season/" + s] && b["season/" + s].episodes || []) info.set(`${s}.${ep.episode_number}`, ep);
      }
    });
  } catch (_) {
  }
  return { show, info };
}
async function episodes(ref) {
  const p = parseRef(ref);
  if (!p || p.kind !== "series") throw notFound("not a series ref: " + ref);
  const { seasons } = await seriesDocument(p.id);
  const { show, info } = await seasonInfo(p.id, [...seasons.keys()]);
  const out = [];
  for (const [s, list] of seasons) {
    for (const ep of list) {
      const t2 = info.get(`${s}.${ep.e}`);
      out.push({
        season: s,
        number: ep.e,
        ref: `e:${p.id}:${s}:${ep.e}`,
        title: t2 && t2.name || text(`Episodio ${ep.e}`, `Episode ${ep.e}`),
        still: t2 ? img("w300", t2.still_path) : void 0,
        overview: t2 && t2.overview || void 0,
        airDate: t2 && /^\d{4}-\d{2}-\d{2}$/.test(t2.air_date || "") ? t2.air_date : void 0,
        runtimeMinutes: t2 && t2.runtime > 0 && t2.runtime <= 1e3 ? t2.runtime : void 0
      });
    }
  }
  out.sort((a, b) => a.season - b.season || a.number - b.number);
  return show ? { series: infoOf(show, true), episodes: out } : { episodes: out };
}
function maxQualityCap() {
  let v;
  try {
    v = getKino6().config.get("maxQuality");
  } catch (_) {
  }
  const m = /^(\d{3,4})p$/i.exec(String(v || "").trim());
  return m ? Number(m[1]) : DEFAULT_CAP;
}
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
var choose = (variants, quality) => quality && variants.find((v) => v.quality === quality) || pickDefault(variants);
function sizeText(size) {
  const n = /^\d+$/.test(String(size)) ? Number(size) : NaN;
  if (!Number.isFinite(n)) return String(size || "");
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  return Math.round(n / 1024 ** 2) + " MB";
}
var labelOf = (v) => [v.quality, sizeText(v.size)].filter(Boolean).join(" \xB7 ").slice(0, 48);
async function resolve(ref) {
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
  const alternatives = variants.filter((v) => v.quality !== chosen.quality).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality)).map((v) => ({ label: labelOf(v), ref: `${p.base}#${v.quality}` }));
  return { url, label: labelOf(chosen), ...alternatives.length ? { alternatives } : {} };
}

// src/i18n.js
var DICT = {
  catalogReady: { es: "{n} t\xEDtulos disponibles", en: "{n} titles available" },
  catalogPending: { es: "{n} t\xEDtulos; hay una actualizaci\xF3n pendiente, se aplica al abrir Movie+", en: "{n} titles; an update is pending, it applies when you open Movie+" },
  catalogEmpty: { es: "A\xFAn no descargado; abre Movie+ para descargarlo", en: "Not downloaded yet; open Movie+ to download it" }
};
function t(key, lang = "es", params = {}) {
  const entry = DICT[key];
  if (!entry) return key;
  const text2 = entry[lang] || entry.es;
  return text2.replace(/\{(\w+)\}/g, (m, name) => name in params ? String(params[name]) : m);
}

// src/movp/refresh.js
var REMOTE_KEY = "movp:catalog:remote:v1";
var PENDING_KEY = "movp:catalog:pending:v1";
var getKino7 = () => globalThis.kino;
async function remoteSignature() {
  for (const url of CATALOG_URLS) {
    try {
      const resp = await getKino7().fetch(url, { method: "HEAD", timeoutMs: 15e3 });
      if (!resp.ok) continue;
      const h = resp.headers || {};
      const sig = [h.etag, h["last-modified"], h["content-length"]].filter(Boolean).join("|");
      if (sig) return `${new URL(url).host}|${sig}`;
    } catch (_) {
    }
  }
  return null;
}
async function recordRemote(sig) {
  try {
    const s = sig || await remoteSignature();
    if (s) getKino7().storage.set(REMOTE_KEY, s);
  } catch (_) {
  }
}
async function checkRemote() {
  try {
    const sig = await remoteSignature();
    if (!sig) return { changed: false };
    const st = getKino7().storage;
    const last = st.get(REMOTE_KEY);
    st.set(REMOTE_KEY, sig);
    const hostOf = (v) => String(v).split("|", 1)[0];
    if (last != null && last !== sig && hostOf(last) === hostOf(sig)) {
      st.set(PENDING_KEY, "1");
      return { changed: true };
    }
  } catch (_) {
  }
  return { changed: false };
}
var refreshPending = () => getKino7().storage.get(PENDING_KEY) != null;
var clearRefreshPending = () => getKino7().storage.remove(PENDING_KEY);
function catalogStatusText(count, lang) {
  if (!count) return t("catalogEmpty", lang);
  return t(refreshPending() ? "catalogPending" : "catalogReady", lang, { n: count });
}

// src/screen/gate.js
var TITLE = "Movie+";
var TICK_MS = 1e3;
var IMPORT_BATCH = 500;
var CHUNK_CHARS = 4e5;
var META_KEY = "movp:gate:meta";
var CHUNK_KEY = "movp:gate:raw:";
var GATE_EVENTS = /* @__PURE__ */ new Set(["open", "download", "fetchCatalog", "importTick"]);
var getKino8 = () => globalThis.kino;
var FAILED_DOWNLOAD = { text: "No se pudo descargar; reintenta", textEn: "Download failed; try again", role: "error" };
function needsGate(state) {
  const s = state || {};
  return !!(s.members || s.verifyFailed || s.downloading || s.importing || !s.ready || s.empty);
}
function gateView(state) {
  const s = state || {};
  const phase = s.phase || (s.downloading ? "downloading" : s.importing ? "importing" : !s.ready ? "loading" : "idle");
  const children = [
    { type: "Text", text: TITLE, style: "h1" },
    { type: "Text", text: "Pel\xEDculas y series para ver cuando quieras.", textEn: "Movies and series to watch whenever you want.", style: "p" }
  ];
  let tick = null;
  if (s.members) {
    children.push({
      type: "Text",
      text: "Movie+ es para los miembros del grupo de Kino. \xDAnete al grupo y vuelve a intentarlo.",
      textEn: "Movie+ is for members of the Kino group. Join the group and try again.",
      style: "p"
    });
    children.push({
      type: "ElevatedButton",
      icon: "open_in_new",
      labelText: "Unirme al grupo",
      labelTextEn: "Join the group",
      onPressed: { go: { url: { href: "https://t.me/Kinoapptv", title: "Grupo de Kino" } } }
    });
    children.push({ type: "TextButton", labelText: "Ya me un\xED, reintentar", labelTextEn: "I joined \u2014 retry", onPressed: "verify" });
  } else if (s.verifyFailed) {
    children.push({
      type: "Text",
      text: "No se pudo verificar tu acceso. Revisa tu conexi\xF3n y reintenta.",
      textEn: "Could not verify your access. Check your connection and try again.",
      style: "p"
    });
    children.push({ type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", labelTextEn: "Retry", onPressed: "verify" });
  } else if (phase === "loading") {
    children.push({ type: "CircularProgressIndicator", text: "Cargando\u2026", textEn: "Loading\u2026" });
  } else if (phase === "downloading") {
    children.push({ type: "LinearProgressIndicator", labelText: "Descargando cat\xE1logo\u2026", labelTextEn: "Downloading catalog\u2026" });
    tick = "fetchCatalog";
  } else if (phase === "importing") {
    const done = Number(s.cursor) || 0;
    const total = Number(s.total) || 0;
    children.push({
      type: "LinearProgressIndicator",
      value: total ? Math.min(1, done / total) : 0,
      labelText: `Importando cat\xE1logo\u2026 ${done} / ${total}`,
      labelTextEn: `Importing catalog\u2026 ${done} / ${total}`
    });
    tick = "importTick";
  } else {
    children.push({ type: "ElevatedButton", labelText: "Descargar cat\xE1logo", labelTextEn: "Download catalog", onPressed: "download" });
  }
  const tree = {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      title: TITLE,
      mergeWithKinoBar: true,
      dense: true,
      leading: { type: "IconButton", icon: "close", onPressed: "close_screen", labelText: "Cerrar", labelTextEn: "Close" }
    },
    body: { type: "Column", mainAxisAlignment: "center", crossAxisAlignment: "center", padding: 24, gap: 16, children }
  };
  return tick ? { ...tree, every: [{ ms: TICK_MS, event: tick }] } : tree;
}
function readMeta() {
  try {
    const m = JSON.parse(getKino8().storage.get(META_KEY) || "null");
    return m && Number.isInteger(m.chunks) && m.chunks > 0 ? m : null;
  } catch (_) {
    return null;
  }
}
function writeMeta(meta) {
  getKino8().storage.set(META_KEY, JSON.stringify(meta));
}
function clearRaw() {
  const st = getKino8().storage;
  const meta = readMeta();
  if (meta) for (let i = 0; i < meta.chunks; i++) st.remove(CHUNK_KEY + i);
  st.remove(META_KEY);
}
function chunkText(text2) {
  const out = [];
  for (let i = 0; i < text2.length; ) {
    let end = Math.min(i + CHUNK_CHARS, text2.length);
    const last = text2.charCodeAt(end - 1);
    if (end < text2.length && last >= 55296 && last <= 56319) end--;
    out.push(text2.slice(i, end));
    i = end;
  }
  return out;
}
function storeRaw(text2, total, remote) {
  clearRaw();
  const chunks = chunkText(text2);
  try {
    chunks.forEach((c, i) => getKino8().storage.set(CHUNK_KEY + i, c));
    writeMeta({ chunks: chunks.length, total, cursor: { si: 0, off: -1, done: 0, recent: null }, remote });
  } catch (err) {
    for (let i = 0; i < chunks.length; i++) getKino8().storage.remove(CHUNK_KEY + i);
    throw err;
  }
}
function loadRaw(meta) {
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) {
    const c = getKino8().storage.get(CHUNK_KEY + i);
    if (c == null) return null;
    parts.push(c);
  }
  return parts.join("");
}
async function open() {
  const meta = readMeta();
  if (meta) {
    const done = meta.cursor && Number(meta.cursor.done) || 0;
    return { state: { ready: true, importing: true, cursor: done, total: Number(meta.total) || 0 } };
  }
  if (await catalogCount() === 0 || !await isCatalogReady() || refreshPending()) return { state: { ready: true, downloading: true } };
  return { state: { ready: true, downloading: false, importing: false, empty: false } };
}
async function fetchStep() {
  try {
    const remote = await remoteSignature();
    const text2 = await fetchCatalogText();
    const total = countItemsText(text2);
    storeRaw(text2, total, remote);
    try {
      getKino8().log && getKino8().log(`Movie+ download done: ${total} items, ${text2.length} chars; starting streamed import`);
    } catch (_) {
    }
    return { state: { downloading: false, importing: true, cursor: 0, total } };
  } catch (_) {
    return { state: { downloading: false, ready: true, empty: true }, toast: FAILED_DOWNLOAD };
  }
}
async function importStep() {
  const meta = readMeta();
  const text2 = meta && loadRaw(meta);
  if (!text2) {
    clearRaw();
    if (await isCatalogReady()) return { state: { importing: false, ready: true, empty: false, imported: true } };
    return { state: { importing: false, ready: true, empty: true } };
  }
  try {
    const next = await importTextTick(text2, meta.cursor, IMPORT_BATCH);
    const total = Number(meta.total) || next.done;
    try {
      getKino8().log && getKino8().log(`Movie+ import tick: ${next.done}/${total}${next.finished ? " (finished)" : ""}`);
    } catch (_) {
    }
    if (next.finished) {
      finishImport(next.recent, total);
      clearRaw();
      clearRefreshPending();
      await recordRemote(meta.remote);
      return { state: { importing: false, ready: true, empty: false, imported: true, cursor: total, total } };
    }
    writeMeta({ ...meta, cursor: { si: next.si, off: next.off, done: next.done, recent: next.recent } });
    return { state: { cursor: next.done, total } };
  } catch (_) {
    clearRaw();
    return { state: { importing: false, ready: true, empty: true }, toast: FAILED_DOWNLOAD };
  }
}
async function handleGateEvent(name, _value, _state) {
  switch (name) {
    case "open":
      return open();
    case "download":
      return { state: { downloading: true } };
    case "fetchCatalog":
      return fetchStep();
    case "importTick":
      return importStep();
    default:
      return null;
  }
}

// src/screen/view.js
var TITLE2 = "Movie+";
var DEFAULT_TAB = CATEGORIES[0].key;
var SETTINGS_TAB = "settings";
var tabKeyOf = (value) => CATEGORIES.some((c) => c.key === value) ? value : value === SETTINGS_TAB ? SETTINGS_TAB : DEFAULT_TAB;
function appBar(searching) {
  if (searching) {
    return {
      type: "AppBar",
      mergeWithKinoBar: true,
      dense: true,
      leading: { type: "IconButton", icon: "arrow_back", onPressed: "close_search", labelText: "Cerrar", labelTextEn: "Close" },
      title: {
        type: "TextField",
        key: "q",
        kind: "search",
        autofocus: true,
        hintText: "Buscar en Movie+",
        hintTextEn: "Search Movie+",
        onSubmitted: "search",
        trailingIcon: "search",
        trailingLabel: "Buscar",
        trailingLabelEn: "Search",
        onTrailingTap: "search"
      }
    };
  }
  return {
    type: "AppBar",
    title: TITLE2,
    mergeWithKinoBar: true,
    dense: true,
    leading: { type: "IconButton", icon: "close", onPressed: "close_screen", labelText: "Cerrar", labelTextEn: "Close" },
    actions: [
      { type: "IconButton", icon: "search", onPressed: "open_search", labelText: "Buscar", labelTextEn: "Search" },
      { type: "IconButton", icon: "refresh", onPressed: "refresh", labelText: "Actualizar", labelTextEn: "Refresh" },
      { type: "IconButton", icon: "settings", onPressed: "open_settings", labelText: "Ajustes", labelTextEn: "Settings" }
    ]
  };
}
function tabBar(tab) {
  return {
    type: "TabBar",
    key: "tab",
    value: tab === SETTINGS_TAB ? DEFAULT_TAB : tab,
    onChanged: "tab",
    tabs: CATEGORIES.map((c) => ({ value: c.key, label: c.label, labelEn: c.labelEn }))
  };
}
function rail(row) {
  return { type: "titleRail", title: row.title, titleEn: row.titleEn, ref: row.ref, items: row.items };
}
function emptyRow() {
  return {
    type: "emptyState",
    icon: "movie",
    title: "A\xFAn no hay t\xEDtulos aqu\xED",
    titleEn: "No titles here yet",
    text: "Esta categor\xEDa no tiene contenido por ahora.",
    textEn: "This category has no content for now."
  };
}
function browseBody(view) {
  const rows = (view && view.rows || []).filter((r) => r && Array.isArray(r.items) && r.items.length);
  const children = rows.length ? rows.map(rail) : [emptyRow()];
  return { type: "SingleChildScrollView", flex: 1, children: [{ type: "Column", gap: 12, children }] };
}
function settingsBody(view) {
  const count = Number(view && view.count) || 0;
  return {
    type: "SingleChildScrollView",
    flex: 1,
    children: [{
      type: "Column",
      padding: 16,
      gap: 12,
      children: [
        { type: "ListTile", title: "Cat\xE1logo", titleEn: "Catalog", subtitle: `${count} t\xEDtulos`, subtitleEn: `${count} titles` },
        { type: "Divider" },
        { type: "ElevatedButton", labelText: "Volver a descargar el cat\xE1logo", labelTextEn: "Download the catalog again", onPressed: "download" }
      ]
    }]
  };
}
function richView(state) {
  const s = state || {};
  const tab = tabKeyOf(s.tab);
  const body = tab === SETTINGS_TAB ? settingsBody(s.view) : browseBody(s.view);
  return {
    type: "Scaffold",
    appBar: appBar(!!s.searching),
    body: { type: "Column", children: [tabBar(tab), body] }
  };
}

// src/screen/index.js
var LOAD_ITEMS = 60;
var RECENT_ROW = 20;
var GENRE_ROWS = 3;
var GENRE_MIN = 4;
var QUERY_MAX = 200;
function genreRows(items, key) {
  const counts = /* @__PURE__ */ new Map();
  for (const it of items) for (const g of it.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= GENRE_MIN).sort((a, b) => b[1] - a[1]).slice(0, GENRE_ROWS).map(([g]) => ({ title: g, titleEn: g, ref: key + ":" + g, items: items.filter((it) => (it.genres || []).includes(g)).slice(0, RECENT_ROW) }));
}
async function loadView(tab) {
  if (tab === SETTINGS_TAB) return { tab, count: await catalogCount() };
  const cat = CATEGORIES.find((c) => c.key === tab);
  const items = (await recentByCategory(tab, LOAD_ITEMS)).map(card);
  const rows = [];
  if (items.length) {
    rows.push({ title: `${cat.label}: recientes`, titleEn: `${cat.labelEn}: recent`, ref: tab, items: items.slice(0, RECENT_ROW) });
    rows.push(...genreRows(items, tab));
  }
  return { tab, rows };
}
async function readyState(tab) {
  const t2 = tabKeyOf(tab);
  return { ready: true, empty: false, downloading: false, importing: false, tab: t2, view: await loadView(t2) };
}
async function screen(arg) {
  const state = arg && arg.state || {};
  return needsGate(state) ? gateView(state) : richView(state);
}
async function afterGate(answer, state) {
  const merged = { ...state, ...answer && answer.state || {} };
  if (!answer || !answer.state || needsGate(merged)) return answer;
  return { ...answer, state: { ...answer.state, ...await readyState(merged.tab || DEFAULT_TAB) } };
}
async function screenEvent(ev) {
  const name = ev && (ev.name != null ? ev.name : ev.event);
  const value = ev && (ev.value != null ? ev.value : ev.arg);
  const state = ev && ev.state || {};
  try {
    if (name === "open" || name === "verify") {
      const clear = { members: false, verifyFailed: false };
      try {
        await ensureRecipe();
      } catch (e) {
        const code = e && e.code;
        if (code === "not_member") return { state: { ready: true, members: true, verifyFailed: false, downloading: false, importing: false, empty: false } };
        return { state: { ready: true, verifyFailed: true, members: false } };
      }
      const base = { ...state, ...clear };
      const answer = await handleGateEvent("open", value, base);
      const merged = { ...base, ...answer.state || {}, ...clear };
      if (needsGate(merged)) return { state: { ...answer.state || {}, ...clear } };
      try {
        await ensureSession();
      } catch (_) {
      }
      return { state: { ...clear, ...await readyState(state.tab || DEFAULT_TAB) } };
    }
    if (GATE_EVENTS.has(name)) return afterGate(await handleGateEvent(name, value, state), state);
    switch (name) {
      case "close_screen":
        return { close: true };
      case "tab": {
        const tab = tabKeyOf(value);
        return { state: { searching: false, ...await readyState(tab) } };
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
        if (!await isCatalogReady()) return { state: { ready: true, empty: true } };
        return { state: await readyState(state.tab) };
      }
      default:
        return {};
    }
  } catch (e) {
    try {
      globalThis.kino.log("screenEvent " + name + " failed: " + (e && (e.code || e.message) || e));
    } catch (_) {
    }
    return { state: { ready: true, empty: true }, toast: { text: "No se pudo cargar el cat\xE1logo", textEn: "Could not load the catalog", role: "error" } };
  }
}

// src/plugin.js
async function section() {
  return { items: [] };
}
async function job() {
  return checkRemote();
}
async function settingsStatus() {
  const lang = globalThis.kino.lang === "en" ? "en" : "es";
  try {
    return { catalogStatus: catalogStatusText(await catalogCount(), lang) };
  } catch (_) {
    return { catalogStatus: catalogStatusText(0, lang) };
  }
}
export {
  browse,
  details,
  episodes,
  home,
  job,
  resolve,
  screen,
  screenEvent,
  search,
  section,
  settingsStatus
};
