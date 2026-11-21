import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const logged = [];
const rows = new Map();

class KinoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

globalThis.kino = {
  lang: "es",
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => { store.set(k, String(v)); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  catalog: {
    async upsert(items) { for (const it of items) rows.set(it.id, { ...it }); return { count: items.length }; },
    async get(ids) { return ids.filter((i) => rows.has(i)).map((i) => rows.get(i)); },
    async count() { return rows.size; },
    async search({ limit = 50, offset = 0 } = {}) {
      const all = [...rows.values()].sort((a, b) => b.sort - a.sort);
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
  },
  log: (...a) => { logged.push(a.join(" ")); },
  error: (code, message) => new KinoError(code, message),
  async fetch() { throw new Error("offline"); },
  // kino.vault.get() (apiVersion 28): Kino resolves the plugin's secret itself. Default: a valid recipe (tests that need a
  // non-member or a failure replace this per test).
  vault: { get: async () => ({ apiBase: "https://movp.backend", appVersion: "1", versionCode: 1, channel: "c", settingsProfile: 1, reqPrefix: "RQ", sessionPrefix: "SS" }) },
};

const { CATEGORIES } = await import("../src/movp/catalog.js");
const { screen, screenEvent } = await import("../src/screen/index.js");
const { richView } = await import("../src/screen/view.js");
const plugin = await import("../src/plugin.js");

function find(node, pred, out = []) {
  if (node && typeof node === "object") {
    if (pred(node)) out.push(node);
    for (const v of Object.values(node)) find(v, pred, out);
  }
  return out;
}

function row(id, type, title, genres = "Acción") {
  return { id, title, sort: Number(id.slice(2)), data: { k: id[0] === "m" ? "movie" : "series", t: type, y: "2024", p: "/p" + id.slice(2) + ".jpg", g: genres } };
}

function installCatalog() {
  for (let i = 1; i <= 25; i++) rows.set("m:" + i, row("m:" + i, 1, "Peli " + i));
  for (let i = 101; i <= 103; i++) rows.set("s:" + i, row("s:" + i, 2, "Serie " + i));
  store.set("movp:catalog:v1", JSON.stringify({ at: 1, total: rows.size }));
  store.set("movp:session:v1", JSON.stringify({ sessionToken: "t", grants: { catalog: "x" }, deviceId: "d", expiresAtMs: Date.now() + 3600000 }));
}

beforeEach(() => {
  store.clear();
  rows.clear();
  // A cached recipe so the vault "verify" step short-circuits (no network) and `open` proceeds to the catalog gate.
  store.set("movp:recipe:v1", JSON.stringify({ at: Date.now(), recipe: {
    apiBase: "https://movp.backend", appVersion: "1", versionCode: 1, channel: "c", settingsProfile: 1, reqPrefix: "RQ", sessionPrefix: "SS",
  } }));
});

test("richView normal: Movie+ AppBar with close and search/refresh/settings actions", () => {
  const v = richView({ ready: true, tab: "peliculas", view: { tab: "peliculas", rows: [] } });
  assert.equal(v.type, "Scaffold");
  assert.equal(v.appBar.type, "AppBar");
  assert.equal(v.appBar.title, "Movie+");
  assert.equal(v.appBar.mergeWithKinoBar, true);
  assert.equal(v.appBar.dense, true);
  assert.deepEqual(v.appBar.leading, { type: "IconButton", icon: "close", onPressed: "close_screen", labelText: "Cerrar", labelTextEn: "Close" });
  assert.deepEqual(v.appBar.actions.map((a) => [a.icon, a.onPressed]), [["search", "open_search"], ["refresh", "refresh"], ["settings", "open_settings"]]);
});

test("richView: TabBar with the 6 categories in order", () => {
  const [bar] = find(richView({ ready: true, tab: "series" }), (n) => n.type === "TabBar");
  assert.equal(bar.key, "tab");
  assert.equal(bar.onChanged, "tab");
  assert.equal(bar.value, "series");
  assert.deepEqual(bar.tabs.map((t) => t.label), ["Películas", "Series", "Animes-Cartoons", "Doramas", "Duanju", "Telenovelas"]);
  assert.deepEqual(bar.tabs.map((t) => t.value), CATEGORIES.map((c) => c.key));
  assert.ok(bar.tabs.every((t) => t.labelEn));
});

test("richView search mode: back arrow and a search TextField", () => {
  const v = richView({ ready: true, searching: true });
  assert.equal(v.appBar.mergeWithKinoBar, true);
  assert.equal(v.appBar.leading.icon, "arrow_back");
  assert.equal(v.appBar.leading.onPressed, "close_search");
  assert.deepEqual(v.appBar.title, {
    type: "TextField", key: "q", kind: "search", autofocus: true, hintText: "Buscar en Movie+", hintTextEn: "Search Movie+",
    onSubmitted: "search", trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: "search",
  });
});

test("richView draws poster rows whose items open the native detail", () => {
  const item = { id: "m15066", ref: "m:15066", title: "X", kind: "movie", poster: "https://image.tmdb.org/t/p/w342/p.jpg", ids: { tmdb: 15066 } };
  const v = richView({ ready: true, tab: "peliculas", view: { rows: [{ title: "Recientes", titleEn: "Recent", ref: "peliculas", items: [item] }] } });
  const [rail] = find(v, (n) => n.type === "titleRail");
  assert.equal(rail.ref, "peliculas");
  assert.deepEqual(rail.items, [item]);
});

test("richView: an empty tab (Duanju) draws an empty state without throwing", () => {
  for (const view of [undefined, { tab: "duanju", rows: [] }, { rows: [{ title: "x", items: [] }] }]) {
    const v = richView({ ready: true, tab: "duanju", view });
    assert.equal(find(v, (n) => n.type === "emptyState").length, 1);
    assert.equal(find(v, (n) => n.type === "titleRail").length, 0);
  }
});

test("screen is a pure view: gate until ready, rich view after", async () => {
  assert.equal((await screen({})).appBar.title, "Movie+");
  assert.equal(find(await screen({}), (n) => n.type === "CircularProgressIndicator").length, 1);
  assert.equal(find(await screen({ state: { ready: true, downloading: true } }), (n) => n.type === "LinearProgressIndicator").length, 1);
  assert.equal(find(await screen({ state: { ready: true, empty: true } }), (n) => n.type === "ElevatedButton")[0].onPressed, "download");
  assert.equal(find(await screen({ state: { ready: true, tab: "peliculas" } }), (n) => n.type === "TabBar").length, 1);
});

test("search with a query hands off to Kino's native search", async () => {
  assert.deepEqual(await screenEvent({ name: "search", value: "batman", state: { searching: true } }), { go: { search: { q: "batman" } }, state: { searching: false } });
  const r = await screenEvent({ name: "search", state: { inputs: { q: " dune " } } });
  assert.deepEqual(r.go, { search: { q: "dune" } });
  assert.deepEqual(await screenEvent({ name: "search", value: "  ", state: {} }), { state: { searching: false } });
});

test("open_search / close_search / close_screen", async () => {
  assert.deepEqual(await screenEvent({ name: "open_search" }), { state: { searching: true } });
  assert.deepEqual(await screenEvent({ name: "close_search" }), { state: { searching: false } });
  assert.deepEqual(await screenEvent({ name: "close_screen" }), { close: true });
});

test("tab loads that category's rows and sets state.tab", async () => {
  installCatalog();
  const r = await screenEvent({ name: "tab", value: "series", state: { ready: true, tab: "peliculas", searching: true } });
  assert.equal(r.state.tab, "series");
  assert.equal(r.state.searching, false);
  assert.equal(r.state.view.rows[0].items.length, 3);
  assert.deepEqual(r.state.view.rows[0].items[0], {
    id: "s103", ref: "s:103", title: "Serie 103", kind: "series", year: 2024,
    poster: "https://image.tmdb.org/t/p/w342/p103.jpg", genres: ["Acción"], ids: { tmdb: 103 },
  });
  assert.equal((await screenEvent({ name: "tab", value: "nope", state: {} })).state.tab, "peliculas");
});

test("empty Duanju tab renders without throwing", async () => {
  installCatalog();
  const r = await screenEvent({ name: "tab", value: "duanju", state: { ready: true } });
  assert.equal(r.state.tab, "duanju");
  assert.deepEqual(r.state.view.rows, []);
  const v = await screen({ state: { ready: true, ...r.state } });
  assert.equal(find(v, (n) => n.type === "emptyState").length, 1);
});

test("peliculas rows: recent (capped) plus genre rows", async () => {
  installCatalog();
  const r = await screenEvent({ name: "tab", value: "peliculas", state: {} });
  const [recent, genre] = r.state.view.rows;
  assert.equal(recent.ref, "peliculas");
  assert.equal(recent.items.length, 20);
  assert.equal(recent.items[0].ref, "m:25");
  assert.equal(genre.title, "Acción");
});

test("open without a catalog falls to the gate (download)", async () => {
  assert.deepEqual(await screenEvent({ name: "open", state: {} }), { state: { ready: true, downloading: true, members: false, verifyFailed: false } });
});

test("two-step gate: a non-member is stopped at the vault (members gate) and the catalog is NEVER downloaded", async () => {
  store.delete("movp:recipe:v1"); // no cached recipe → the vault is actually queried
  const origVault = globalThis.kino.vault;
  // Kino's kino.vault.get() throws not_member for someone outside the group (it ran the whole exchange itself).
  globalThis.kino.vault = { get: async () => { const e = new Error("no"); e.code = "not_member"; throw e; } };
  try {
    const r = await screenEvent({ name: "open", state: {} });
    assert.equal(r.state.members, true, "the members-only gate is shown");
    assert.ok(!r.state.downloading && !r.state.importing, "the catalog is never downloaded for a non-member");
  } finally {
    globalThis.kino.vault = origVault;
  }
});

test("open with an installed catalog loads the first tab", async () => {
  installCatalog();
  const r = await screenEvent({ name: "open", state: {} });
  assert.equal(r.state.ready, true);
  assert.equal(r.state.tab, "peliculas");
  assert.equal(r.state.view.rows.length > 0, true);
  const v = await screen({ state: r.state });
  assert.equal(find(v, (n) => n.type === "titleRail").length > 0, true);
});

test("open still loads the catalog when the session cannot be established (offline)", async () => {
  installCatalog();
  store.delete("movp:session:v1");
  const r = await screenEvent({ name: "open", state: {} });
  assert.equal(r.state.ready, true);
  assert.ok(r.state.view.rows.length);
});

test("gate events are delegated; a finished import leaves the gate with the first tab loaded", async () => {
  assert.deepEqual(await screenEvent({ name: "download", state: {} }), { state: { downloading: true } });
  installCatalog();
  const r = await screenEvent({ name: "importTick", state: { importing: true, cursor: 1, total: 2 } });
  assert.equal(r.state.importing, false);
  assert.equal(r.state.imported, true);
  assert.equal(r.state.tab, "peliculas");
  assert.ok(r.state.view.rows.length);
});

test("refresh reloads the active tab; settings view shows the catalog size", async () => {
  installCatalog();
  const r = await screenEvent({ name: "refresh", state: { ready: true, tab: "series" } });
  assert.equal(r.state.tab, "series");
  assert.equal(r.state.view.rows[0].items.length, 3);
  const s = await screenEvent({ name: "open_settings", state: { ready: true } });
  assert.equal(s.state.tab, "settings");
  const v = await screen({ state: s.state });
  assert.equal(find(v, (n) => n.type === "ListTile")[0].subtitle, "28 títulos");
  assert.equal(find(v, (n) => n.type === "TabBar")[0].value, "peliculas");
});

test("plugin.js exports screen and screenEvent from the screen module", () => {
  assert.equal(plugin.screen, screen);
  assert.equal(plugin.screenEvent, screenEvent);
});

test("an event that throws recovers to the gate with an error toast and a log line", async () => {
  installCatalog();
  const count = kino.catalog.count;
  kino.catalog.count = async () => { throw new Error("boom"); };
  logged.length = 0;
  try {
    const r = await screenEvent({ name: "open", state: {} });
    assert.deepEqual(r.state, { ready: true, empty: true });
    assert.deepEqual(r.toast, { text: "No se pudo cargar el catálogo", textEn: "Could not load the catalog", role: "error" });
    assert.deepEqual(logged, ["screenEvent open failed: boom"]);
    const v = await screen({ state: r.state });
    assert.equal(find(v, (n) => n.type === "ElevatedButton")[0].onPressed, "download");
  } finally {
    kino.catalog.count = count;
  }
});

test("refresh while on settings stays on settings", async () => {
  installCatalog();
  const r = await screenEvent({ name: "refresh", state: { ready: true, tab: "settings" } });
  assert.equal(r.state.tab, "settings");
  assert.equal(r.state.view.count, 28);
  assert.equal(find(await screen({ state: r.state }), (n) => n.type === "ListTile").length, 1);
  assert.equal((await screenEvent({ name: "refresh", state: { ready: true } })).state.tab, "peliculas");
});
