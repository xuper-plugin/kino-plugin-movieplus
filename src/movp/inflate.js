// Pure-JS gzip inflate. kino.crypto.gunzip refuses output over 5 MB and the Movie+ catalog unzips to ~10 MB, so
// catalog.js falls back to this. No Node or Kino APIs: it also bundles for QuickJS and runs under node --test.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Lookup table indexed by the next `bits` input bits (LSB first): entry = (codeLength << 16) | symbol, 0 = no such code.
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
    code = (code + count[l - 1]) << 1;
    next[l] = code;
  }
  const size = 1 << max;
  const table = new Int32Array(size);
  for (let sym = 0; sym < n; sym++) {
    const l = lengths[sym];
    if (!l) continue;
    const c = next[l]++;
    let rev = 0;
    for (let b = 0; b < l; b++) rev |= ((c >> b) & 1) << (l - 1 - b);
    for (let i = rev; i < size; i += 1 << l) table[i] = (l << 16) | sym;
  }
  return { table, bits: max };
}

let fixedTables = null;
function fixed() {
  if (!fixedTables) {
    const l = new Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    fixedTables = { lit: buildTable(l, 288), dist: buildTable(new Array(30).fill(5), 30) };
  }
  return fixedTables;
}

/** Inflate a gzip file (single member) held in a Uint8Array; returns the bytes. */
export function gunzipBytes(src) {
  const n = src.length;
  if (n < 18 || src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) throw new Error("not a gzip stream");
  const flags = src[3];
  let pos = 10;
  if (flags & 4) pos += 2 + (src[pos] | (src[pos + 1] << 8));
  if (flags & 8) { while (src[pos++] !== 0); }
  if (flags & 16) { while (src[pos++] !== 0); }
  if (flags & 2) pos += 2;
  const isize = (src[n - 4] | (src[n - 3] << 8) | (src[n - 2] << 16) | (src[n - 1] << 24)) >>> 0;
  const out = new Uint8Array(isize);
  let op = 0;
  let buf = 0;
  let cnt = 0;

  const bits = (need) => {
    while (cnt < need) { buf |= (pos < n ? src[pos] : 0) << cnt; pos++; cnt += 8; }
    const v = buf & ((1 << need) - 1);
    buf >>>= need;
    cnt -= need;
    return v;
  };
  const decode = (t) => {
    while (cnt < t.bits) { buf |= (pos < n ? src[pos] : 0) << cnt; pos++; cnt += 8; }
    const e = t.table[buf & ((1 << t.bits) - 1)];
    const len = e >> 16;
    if (!len) throw new Error("invalid huffman code");
    buf >>>= len;
    cnt -= len;
    return e & 0xffff;
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
      const len = src[pos] | (src[pos + 1] << 8);
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
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clt);
        if (sym < 16) { lens[i++] = sym; continue; }
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
    for (;;) {
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

/** Inflate a gzip file given as a base64 string; returns the UTF-8 text. */
export function gunzipBase64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(gunzipBytes(bytes));
}
