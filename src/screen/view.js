// Pure render of the branded Movie+ screen: HDFull-style top bar (AppBar + search mode), category TabBar and poster rows.
// Everything is drawn from `state` (rows were loaded by screenEvent into state.view); no network or catalog access here.

import { CATEGORIES } from "../movp/catalog.js";

const TITLE = "Movie+";
export const DEFAULT_TAB = CATEGORIES[0].key;
export const SETTINGS_TAB = "settings";

export const tabKeyOf = (value) => (CATEGORIES.some((c) => c.key === value) ? value : value === SETTINGS_TAB ? SETTINGS_TAB : DEFAULT_TAB);

function appBar(searching) {
  if (searching) {
    return {
      type: "AppBar", mergeWithKinoBar: true, dense: true,
      leading: { type: "IconButton", icon: "arrow_back", onPressed: "close_search", labelText: "Cerrar", labelTextEn: "Close" },
      title: {
        type: "TextField", key: "q", kind: "search", autofocus: true, hintText: "Buscar en Movie+", hintTextEn: "Search Movie+",
        onSubmitted: "search", trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: "search",
      },
    };
  }
  return {
    type: "AppBar", title: TITLE, mergeWithKinoBar: true, dense: true,
    leading: { type: "IconButton", icon: "arrow_back", onPressed: "close_screen", labelText: "Atrás", labelTextEn: "Back" },
    actions: [
      { type: "IconButton", icon: "search", onPressed: "open_search", labelText: "Buscar", labelTextEn: "Search" },
      { type: "IconButton", icon: "refresh", onPressed: "refresh", labelText: "Actualizar", labelTextEn: "Refresh" },
      { type: "IconButton", icon: "settings", onPressed: "open_settings", labelText: "Ajustes", labelTextEn: "Settings" },
    ],
  };
}

function tabBar(tab) {
  return {
    type: "TabBar", key: "tab", value: tab === SETTINGS_TAB ? DEFAULT_TAB : tab, onChanged: "tab",
    tabs: CATEGORIES.map((c) => ({ value: c.key, label: c.label, labelEn: c.labelEn })),
  };
}

// A poster row. The items are contract cards (ref, kind, id, title, poster): Kino opens a tapped one with its NATIVE
// detail page (the same as go.title {ref, kind, id, title}); "Ver más" browses the row's ref.
function rail(row) {
  return { type: "titleRail", title: row.title, titleEn: row.titleEn, ref: row.ref, items: row.items };
}

function emptyRow() {
  return {
    type: "emptyState", icon: "movie",
    title: "Aún no hay títulos aquí", titleEn: "No titles here yet",
    text: "Esta categoría no tiene contenido por ahora.", textEn: "This category has no content for now.",
  };
}

// One hero slide: a big landscape card (backdrop, optional title logo) whose "Ver" button opens Kino's NATIVE
// detail page — the same `go.title` a tapped poster uses. `s`: { id, ref, kind, title, image, logo? }.
function heroSlideNode(s) {
  return {
    type: "heroCard", key: "slide-" + s.id, h: { compact: 200, expanded: 240 },
    ...(s.logo ? { logo: s.logo } : {}),
    title: s.title, image: s.image,
    buttons: [
      { type: "ElevatedButton", key: "heroOpen-" + s.id, icon: "play", labelText: "Ver", labelTextEn: "Watch",
        onPressed: { go: { title: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
    ],
  };
}

// The hero: one slide is drawn alone; several auto-advance in a PageView. The key carries the slide count because
// Kino's pager keeps the count of its first drawing — a slider that changes count crashes with an index out of
// bounds, so a new count needs a new key (same gotcha the browse module documents).
function hero(slides) {
  const list = (slides || []).filter((s) => s && s.id && s.image);
  if (list.length === 0) return null;
  if (list.length === 1) return heroSlideNode(list[0]);
  return { type: "PageView", key: "hero" + list.length, autoPlayMs: 6000, children: list.map(heroSlideNode) };
}

function browseBody(view) {
  const rows = ((view && view.rows) || []).filter((r) => r && Array.isArray(r.items) && r.items.length);
  const h = hero(view && view.slides);
  const rowChildren = rows.length ? rows.map(rail) : [emptyRow()];
  const children = h ? [h, ...rowChildren] : rowChildren;
  return { type: "SingleChildScrollView", flex: 1, children: [{ type: "Column", gap: 12, children }] };
}

function settingsBody(view) {
  const count = Number(view && view.count) || 0;
  return {
    type: "SingleChildScrollView", flex: 1,
    children: [{
      type: "Column", padding: 16, gap: 12,
      children: [
        { type: "ListTile", title: "Catálogo", titleEn: "Catalog", subtitle: `${count} títulos`, subtitleEn: `${count} titles` },
        { type: "Divider" },
        { type: "ElevatedButton", labelText: "Volver a descargar el catálogo", labelTextEn: "Download the catalog again", onPressed: "download" },
      ],
    }],
  };
}

/** Pure render of the rich view from `state`. */
export function richView(state) {
  const s = state || {};
  const tab = tabKeyOf(s.tab);
  const body = tab === SETTINGS_TAB ? settingsBody(s.view) : browseBody(s.view);
  return {
    type: "Scaffold",
    appBar: appBar(!!s.searching),
    body: { type: "Column", children: [tabBar(tab), body] },
  };
}
