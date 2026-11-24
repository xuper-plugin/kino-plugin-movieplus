// Test helpers for the light catalog: build one from the old `{movies, series}` shape, and import a text the way the
// gate does (importTextTick until finished, then finishImport).
import { gzipSync } from "node:zlib";

const row = (x, type) => [x.id, Number(x.type) || type, x.date || "", x.nameFile || "", x.urlImage || "", x.generos || ""];

/** `{movies, series}` (source field names) → the light document `{v:2, items:[[id,type,date,title,poster,genres]]}`. */
export function toLight({ movies = [], series = [] } = {}) {
  return { v: 2, items: [...movies.map((m) => row(m, 1)), ...series.map((s) => row(s, 2))] };
}

export const lightGz = (cat) => gzipSync(JSON.stringify(toLight(cat)));

/** Import the whole light-catalog `text` through the streamed path; resolves to the number of rows scanned. */
export async function importAll(text, batch = 500) {
  const { importTextTick, finishImport } = await import("../src/movp/catalog.js");
  let cursor = null;
  let ticks = 0;
  for (;;) {
    const next = await importTextTick(text, cursor, batch);
    if (++ticks > 100000) throw new Error("import never finished");
    if (next.finished) { finishImport(next.recent, next.done); return next.done; }
    cursor = next;
  }
}
