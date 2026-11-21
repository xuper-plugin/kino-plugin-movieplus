// Scheduled refresh. A job may not use kino.catalog and may read only 2 MB, so it cannot import the ~9 MB catalog: it asks
// a mirror with HEAD whether the catalog file changed and, if so, flags it. The screen's gate sees the flag on open and
// downloads + imports the new copy (the resumable import in catalog.js).

import { CATALOG_URLS } from "./catalog.js";
import { t } from "../i18n.js";

const REMOTE_KEY = "movp:catalog:remote:v1";
const PENDING_KEY = "movp:catalog:pending:v1";

const getKino = () => globalThis.kino;

/** `host|etag|last-modified|length` of the first mirror that answers a HEAD; the host keeps one mirror's headers from being compared with another's. */
export async function remoteSignature() {
  for (const url of CATALOG_URLS) {
    try {
      const resp = await getKino().fetch(url, { method: "HEAD", timeoutMs: 15000 });
      if (!resp.ok) continue;
      const h = resp.headers || {};
      const sig = [h.etag, h["last-modified"], h["content-length"]].filter(Boolean).join("|");
      if (sig) return `${new URL(url).host}|${sig}`;
    } catch (_) { /* next mirror */ }
  }
  return null;
}

/** Writes the baseline the job compares against: `sig` (captured before a download) or a HEAD made now. */
export async function recordRemote(sig) {
  try {
    const s = sig || (await remoteSignature());
    if (s) getKino().storage.set(REMOTE_KEY, s);
  } catch (_) { /* the job records a baseline on its first run */ }
}

/** Job body: record the mirror's file signature; a later different one flags a pending update. Never throws. */
export async function checkRemote() {
  try {
    const sig = await remoteSignature();
    if (!sig) return { changed: false };
    const st = getKino().storage;
    const last = st.get(REMOTE_KEY);
    st.set(REMOTE_KEY, sig);
    const hostOf = (v) => String(v).split("|", 1)[0];
    if (last != null && last !== sig && hostOf(last) === hostOf(sig)) {
      st.set(PENDING_KEY, "1");
      return { changed: true };
    }
  } catch (_) { /* storage or host refused: the next run retries */ }
  return { changed: false };
}

export const refreshPending = () => getKino().storage.get(PENDING_KEY) != null;

export const clearRefreshPending = () => getKino().storage.remove(PENDING_KEY);

/** Text of the manifest's catalogStatus setting. */
export function catalogStatusText(count, lang) {
  if (!count) return t("catalogEmpty", lang);
  return t(refreshPending() ? "catalogPending" : "catalogReady", lang, { n: count });
}
