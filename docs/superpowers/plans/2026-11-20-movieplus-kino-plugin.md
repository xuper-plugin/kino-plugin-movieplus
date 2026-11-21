# Plugin Kino MoviePlus — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un plugin de Kino llamado **Movie+** que sirve el catálogo de MoviePlus (películas y series) con login anónimo, pantalla de marca estilo HDFull con botón de descarga+instalación del catálogo, y detalle/búsqueda nativos de Kino.

**Architecture:** Plugin modular `src/` → `plugin.js` (esbuild), igual que `kino-plugin-latino`. Núcleo: firma RSA-2048 PKCS#1v1.5 hecha a mano con `kino.crypto.hash`+`modPow` (QuickJS no tiene RSA), sesión anónima firmada, catálogo gz indexado en `kino.catalog` (SQLite), y resolución de enlaces a URL directa de Yandex. La UI es un `screen` propio con barra superior; el detalle y la búsqueda se delegan a Kino (`go.title`, `go.search`).

**Tech Stack:** JavaScript (QuickJS sandbox de Kino), apiVersion 14, esbuild, Node para pruebas (kit `sdk/`), `kino.catalog`, `kino.crypto`, `kino.fetch`, `kino.tmdb`.

**Spec:** `docs/superpowers/specs/2026-11-20-movieplus-kino-plugin-design.md`

## Global Constraints

- Backend: `https://api.appsxploit.dev`. App version `17.4`, versionCode `90355`, channel `prod`, settingsProfile `7`.
- Firma session: RSA-PKCS1v15-SHA256 sobre `MOVP-HYBRID-SESSION-V1\n{jwtChallenge}\n{deviceId}`, base64.
- Firma request: header `X-MOVP-Hybrid-Signature` = base64(RSA sobre `MOVP-HYBRID-REQUEST-V1\n{MÉTODO}\n{path}\n{sha256hex(body)}\n{nonce}\n{sha256hex(sessionToken)}`); además `X-MOVP-Hybrid-Session`, `X-MOVP-Hybrid-Nonce` (uuid4 hex sin guiones), `X-MOVP-App-Version: 17.4`, `X-MOVP-App-Version-Code: 90355`. `sha256` siempre **hex minúscula**.
- `installationId = "install_" + sha256hex(SPKI_DER_bytes)`.
- Grants: `catalog` (movie-variants, document), `catalog-value` (playback).
- playback body: `issuedAtMs = Math.floor(Date.now()/1000)*1000 - 1000`.
- Catálogo (gz, con fallback en orden): `https://raw.githubusercontent.com/dev-mplus01/mplus01T/main/db/items.json.gz`, `https://appsdevxp.com/app/db/items.json.gz`, `https://developerxploit.com/app/db/items.json.gz`.
- Mapeo categoría→tipos: Películas=[1], Series=[2], Animes-Cartoons=[3,4], Doramas=[6], Telenovelas=[5], Duanju=[7]. Orden barra: Películas, Series, Animes-Cartoons, Doramas, Duanju, Telenovelas.
- `id` del catálogo == id TMDB. Refs: `m:<id>` película, `s:<id>` serie, `e:<id>:<S>:<E>` episodio.
- Sin secretos. Si alguno hiciera falta: sellar con `sdk/seal.mjs`, nunca en claro.
- Pósters/metadatos vía `kino.tmdb()` (sin llave propia). `urlImage` del catálogo es `poster_path` TMDB.
- **Nombre visible del plugin: `Movie+`** (`name` en manifest, label del `screen`, títulos de gate). `id` interno: `movieplus`.
- **Catálogo se descarga e instala una vez** en `kino.catalog` con gate de progreso (patrón hdfull), reanudable por lotes.
- Cliente de referencia (fuente de verdad del protocolo y vectores): `/tmp/opencode/movieplus.py`, `test_standalone.py`, `test_series_doc.py`, `test_rsa_manual.py`.

## Review Focus

- **Sesión expirada (401 mitad de navegación):** el token dura ~9 min; una llamada que recibe 401 debe re-hacer el handshake una vez y reintentar, no fallar. Test en Task 3.
- **URL de Yandex caducada:** resolver siempre en el momento de `resolve`, nunca cachear la URL final; un token caducado debe dar error claro, no un enlace muerto. Test en Task 5.
- **Serie con nombres de episodio sin `SxxEyy`:** el parseo debe caer a numeración secuencial por orden, no descartar el episodio. Test en Task 5.
- **Pestaña Duanju vacía (0 ítems):** `browse`/`screen` deben mostrar estado vacío correcto, no romper. Test en Task 6/7.
- **Keygen en caja lenta / primera ejecución:** la identidad se genera una vez y se cachea; una segunda llamada no regenera. Test en Task 2.

---

### Task 1: Scaffold del repo, manifiesto y build

**Files:**
- Create: `kino-plugin.json`, `package.json`, `scripts/build.mjs`, `src/plugin.js`, `.gitignore`, `README.md`
- Copy: `sdk/` (desde `kino-plugin-latino/sdk/`), `icon.png`, `panel-icon.png` (placeholder MoviePlus rojo)
- Test: `node sdk/validate.mjs .`

**Interfaces:**
- Produces: manifest con `id:"movieplus"`, `name:"Movie+"`, `apiVersion:14`, `capabilities:["home","browse","search","episodes","resolve","catalog","screen","schedule"]`, `streamHosts:"any"`, `categories:["movies","series"]`, `hosts:[api.appsxploit.dev, raw.githubusercontent.com, appsdevxp.com, developerxploit.com, yadi.sk, disk.yandex.com, *.yandex.net, mds.storage.yandex.net]`, bloque `screen` (label "Movie+", icon "movie", menuOpens "screen", opensFrom ["menu","settings"]), `color:"#D80000"`, `theme` rojo. `src/plugin.js` re-exporta stubs vacíos de cada capability.

- [ ] **Step 1: Crear el repo** `git init` en `kino-plugin-movieplus/`, copiar `sdk/`, `scripts/build.mjs`, `package.json` de `kino-plugin-latino` adaptando nombre/id. Commit del design + plan ya presentes.
- [ ] **Step 2: Escribir `kino-plugin.json`** con los valores del bloque Interfaces y Global Constraints.
- [ ] **Step 3: Escribir `src/plugin.js`** con `export async function home(){return{sections:[]}}` y stubs análogos (`browse,search,episodes,resolve,screen,screenEvent`) que devuelvan vacío.
- [ ] **Step 4: Build** `node scripts/build.mjs` genera `plugin.js`. Run y verifica que existe.
- [ ] **Step 5: Validar** Run: `node sdk/validate.mjs .` — Expected: PASS (manifiesto y exports válidos).
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: scaffold movieplus kino plugin"`

---

### Task 2: Núcleo criptográfico RSA (keygen + firma)

**Files:**
- Create: `src/movp/crypto.js`
- Test: `test/crypto.test.mjs` (+ vectores dorados `test/fixtures/rsa-vectors.json`)

**Interfaces:**
- Consumes: `kino.crypto.hash`, `kino.crypto.modPow`, `kino.storage` (via inyección en test con un shim).
- Produces:
  - `sha256hex(strOrBytesHex): string`
  - `generateIdentity(): { privPkcs1Pem|{n,d,e}, spkiB64, installationId, deviceId }` — genera RSA-2048 (BigInt+Miller-Rabin), construye SPKI DER, `installationId="install_"+sha256hex(spkiBytes)`, `deviceId=uuid`.
  - `getIdentity(): identity` — lee de `kino.storage` o llama `generateIdentity()` una vez y la cachea.
  - `signPkcs1(identity, message: string): base64` — EMSA-PKCS1-v1_5(SHA-256) + `modPow(em, d, n)`.

- [ ] **Step 1: Escribir test de firma contra vector dorado.** Generar `test/fixtures/rsa-vectors.json` con el cliente Python (`test_rsa_manual.py`): una clave fija (n,d,e), un mensaje, y la firma base64 esperada. Test: `signPkcs1(key, msg) === vector.sig`.
- [ ] **Step 2: Run** `node --test test/crypto.test.mjs` — Expected: FAIL (función no existe).
- [ ] **Step 3: Implementar `signPkcs1`** en `src/movp/crypto.js`: SHA-256 del mensaje, prefijo DigestInfo `3031300d060960864801650304020105000420`, relleno `00 01 FF… 00`, `modPow(em,d,n)`, a bytes big-endian de `klen`, base64. En el runtime usa `kino.crypto.modPow`; en test, un shim con BigInt.
- [ ] **Step 4: Run** Expected: PASS.
- [ ] **Step 5: Test keygen + SPKI + installationId.** Test: `generateIdentity()` produce `spkiB64` cuyo `sha256hex(decode)` == `installationId.slice(8)`, y `n` de 2048 bits. Test de cacheo: dos `getIdentity()` devuelven la misma clave (shim de storage cuenta las generaciones == 1).
- [ ] **Step 6: Run** Expected: FAIL → **implementar** keygen BigInt (primos 1024b, Miller-Rabin 8 rondas, trial-division previa), builder SPKI DER (ASN.1 SEQUENCE rsaEncryption + BIT STRING de `SEQUENCE{INTEGER n, INTEGER e}`), `getIdentity` con `kino.storage`.
- [ ] **Step 7: Run** Expected: PASS.
- [ ] **Step 8: Commit** `feat: RSA keygen and PKCS1v15 signing via modPow`

---

### Task 3: Sesión anónima firmada

**Files:**
- Create: `src/movp/session.js`
- Test: `test/session.test.mjs` (+ `test/fixtures/session-responses.json` grabados del server real)

**Interfaces:**
- Consumes: `crypto.js` (`getIdentity`, `signPkcs1`, `sha256hex`), `kino.fetch`, `kino.storage`.
- Produces:
  - `signedFetch(path, bodyObj): Promise<respObj>` — POST firmado a `API+path`; añade los 5 headers `X-MOVP-*`.
  - `ensureSession(): Promise<{sessionToken, grants, deviceId}>` — si hay sesión válida en storage la reutiliza; si no, ejecuta `challenge→session→bootstrap→auth guest`, guarda token+grants+expiración.
  - `call(path, bodyObj): Promise<respObj>` — `ensureSession()` + `signedFetch`; ante HTTP 401/sesión inválida, re-hace sesión una vez y reintenta.

- [ ] **Step 1: Test de preimagen/headers.** Con `kino.fetch` mockeado, test: `signedFetch("/v2/client/bootstrap",{...})` produce header `X-MOVP-Hybrid-Signature` == firma esperada del vector, `X-MOVP-Hybrid-Nonce` hex de 32, y `X-MOVP-App-Version-Code:"90355"`.
- [ ] **Step 2: Run** Expected: FAIL.
- [ ] **Step 3: Implementar `signedFetch`** con la preimagen de Global Constraints.
- [ ] **Step 4: Run** Expected: PASS.
- [ ] **Step 5: Test handshake con fixtures.** `kino.fetch` mock devuelve `session-responses.json` (challenge→session→bootstrap→auth). Test: `ensureSession()` deja `grants.catalog` y `grants["catalog-value"]` no vacíos y un `sessionToken`.
- [ ] **Step 6: Run** FAIL → **implementar** `ensureSession` (orden exacto, body de cada paso del Global Constraints) y `call` con reintento ante 401.
- [ ] **Step 7: Test reintento 401:** primer `call` devuelve 401 una vez, el mock re-emite sesión, el segundo intento pasa; `ensureSession` se llamó 2 veces. (Review Focus #1.)
- [ ] **Step 8: Run** Expected: PASS.
- [ ] **Step 9: Commit** `feat: anonymous signed session handshake`

---

### Task 4: Catálogo e indexado en kino.catalog

**Files:**
- Create: `src/movp/catalog.js`
- Test: `test/catalog.test.mjs` (+ `test/fixtures/items-sample.json.gz` recortado a ~30 ítems de varios tipos)

**Interfaces:**
- Consumes: `kino.fetch`, `kino.catalog`.
- Produces:
  - `CATEGORIES` — array ordenado `[{key, label, labelEn, types}]` con el mapeo del Global Constraints.
  - `typeToCategory(type): key`
  - `fetchCatalog(): Promise<{movies,series}>` — baja y descomprime el gz (fallbacks en orden).
  - `toCatalogItems(cat): [{id, kind, type, title, year, poster, genres, categoryKey}]` — `id="m:"+id` o `"s:"+id`.
  - `importCatalog(cat, {batch, cursor}): {done, cursor, total}` — upsert a `kino.catalog` por lotes, **reanudable** (cursor en `kino.storage`), como hdfull.
  - `recentByCategory(categoryKey, limit): Promise<item[]>` — primeros N de las categorías.
  - `catalogCount(): Promise<number>` — `kino.catalog.count()` (para decidir el gate).

- [ ] **Step 1: Test mapeo.** `typeToCategory(4) === "animes"`, `CATEGORIES[0].key==="peliculas"`, orden correcto.
- [ ] **Step 2: Run** FAIL → **implementar** `CATEGORIES`, `typeToCategory`.
- [ ] **Step 3: Run** PASS.
- [ ] **Step 4: Test parse+import.** Con `items-sample.json.gz` y un shim de `kino.catalog`, test: `importCatalog(await fetchCatalog())` indexa el nº esperado y un ítem conocido (Halo `s:52814`, kind series, categoryKey "series") es recuperable por `kino.catalog.get`.
- [ ] **Step 5: Run** FAIL → **implementar** `fetchCatalog` (gzip via `kino.crypto.gunzip` o `r.base64()`+inflate), `toCatalogItems`, `importCatalog`.
- [ ] **Step 6: Run** PASS.
- [ ] **Step 7: Test import reanudable:** `importCatalog(cat,{batch:10})` dos veces avanza el `cursor` y a la tercera `done:true`; `total` constante. (Soporta el gate de progreso.)
- [ ] **Step 8: Run** FAIL → ajustar `importCatalog` con cursor persistido en `kino.storage`.
- [ ] **Step 9: Run** PASS.
- [ ] **Step 10: Commit** `feat: catalog fetch and resumable kino.catalog indexing`

---

### Task 5: Resolución de reproducción (películas y series)

**Files:**
- Create: `src/movp/resolve.js`
- Test: `test/resolve.test.mjs` (+ `test/fixtures/{movie-variants,document-tv,playback}.json` grabados)

**Interfaces:**
- Consumes: `session.js` (`call`, `ensureSession`).
- Produces:
  - `movieStreams(movieId): Promise<[{quality, size, token}]>` — POST movie-variants (grant catalog), parsea `variants` por `,_,`.
  - `seriesDocument(seriesId): Promise<{seasons: Map<S, [{s,e,name,token,size,quality}]>}>` — POST document (collection "tv"), parsea claves `"Temporada NN/calidad"` y entradas `nombre_SPLIT_token_SPLIT_bytes`; extrae `S(\d+)E(\d+)` del nombre (fallback: índice secuencial).
  - `resolveToken(token): Promise<url>` — POST playback (grant catalog-value, `issuedAtMs` del Global Constraints, `resolveProvider:true`); valida `status==="resolved"`, devuelve `value`. Error claro si no resuelve.

- [ ] **Step 1: Test movieStreams** con fixture: devuelve 2 variantes con quality/size/token no vacíos; token empieza por `Movp2!::`.
- [ ] **Step 2: Run** FAIL → implementar `movieStreams`.
- [ ] **Step 3: Run** PASS.
- [ ] **Step 4: Test seriesDocument** con `document-tv.json` (Halo): `seasons.get(1)` tiene 8+ episodios, cada uno con `{s:1,e:N,token}`; parse de `S01E01`. Test fallback: una entrada con nombre sin `SxxEyy` recibe número secuencial. (Review Focus #3.)
- [ ] **Step 5: Run** FAIL → implementar `seriesDocument`.
- [ ] **Step 6: Run** PASS.
- [ ] **Step 7: Test resolveToken** con `playback.json`: devuelve la URL `mds.storage.yandex.net/...`. Test error: `status!=="resolved"` lanza `kino.error("unavailable", …)`. (Review Focus #2.)
- [ ] **Step 8: Run** FAIL → implementar `resolveToken`.
- [ ] **Step 9: Run** PASS.
- [ ] **Step 10: Commit** `feat: movie and series playback resolution`

---

### Task 6: Exports del contrato (home, browse, search, details, episodes, resolve)

**Files:**
- Create: `src/contract/index.js` (o `home.js, browse.js, search.js, details.js, episodes.js, resolve.js`)
- Modify: `src/plugin.js` (re-exporta el contrato real)
- Test: `test/contract.test.mjs`

**Interfaces:**
- Consumes: `catalog.js`, `resolve.js`, `session.js`, `kino.catalog`, `kino.tmdb`.
- Produces los exports de Kino:
  - `search(query): [{ref, kind, title, poster, year, ids:{tmdb}}]` — busca en `kino.catalog` por nombre.
  - `home(): {sections:[{title, items:[cardFromRef]}]}` — filas "Recientes" por categoría.
  - `browse(ref, cursor): {items, cursor?}` — `ref` = categoryKey o género; pagina desde `kino.catalog`.
  - `details(ref): {title, poster, backdrop, overview, genres, year, rating, ids:{tmdb}}` — vía `kino.tmdb` (`/movie/{id}` o `/tv/{id}`), `id` del ref == tmdb.
  - `episodes(ref="s:<id>"): [{season, number, ref:"e:<id>:<S>:<E>", title, still}]` — de `seriesDocument` + nombres por `kino.tmdb`.
  - `resolve(ref): Stream {url, quality, alternatives?}` — `m:` → `movieStreams`+`resolveToken`; `e:<id>:<S>:<E>` → `seriesDocument`+`resolveToken` del episodio.

- [ ] **Step 1: Test search** (shim catalog): `search("halo")` incluye `{ref:"s:52814", kind:"series"}`.
- [ ] **Step 2–3:** FAIL → implementar `search`; PASS.
- [ ] **Step 4: Test episodes** (shim resolve con `document-tv`): `episodes("s:52814")` devuelve objetos `{season:1, number:1, ref:"e:52814:1:1"}`.
- [ ] **Step 5–6:** FAIL → implementar `episodes` (+ `details` con `kino.tmdb` mock); PASS.
- [ ] **Step 7: Test resolve película y episodio** (shims): `resolve("m:15066")` y `resolve("e:52814:1:1")` devuelven `{url: /mds.storage.yandex.net/}`.
- [ ] **Step 8: Test browse Duanju vacío:** `browse("duanju")` devuelve `{items:[]}` sin lanzar. (Review Focus #4.)
- [ ] **Step 9–10:** FAIL → implementar `home`, `browse`, `resolve`; PASS.
- [ ] **Step 11: Commit** `feat: contract exports wired to catalog and resolver`

---

### Task 7: Gate de descarga/instalación del catálogo (estilo HDFull)

**Files:**
- Create: `src/screen/gate.js` (render del gate), parte de `src/screen/index.js` (`screenEvent`)
- Test: `test/gate.test.mjs`

**Interfaces:**
- Consumes: `catalog.js` (`catalogCount`, `fetchCatalog`, `importCatalog`), `kino.storage`.
- Produces: `gateView(state): node` (fases) y los manejadores `open`/`download`/`fetchCatalog`/`importTick` en `screenEvent`.

- [ ] **Step 1: Test gateView fases.** `gateView({phase:"idle"})` tiene un `ElevatedButton onPressed:"download"` con label "Descargar catálogo"; `gateView({phase:"downloading"})` tiene `LinearProgressIndicator` y `every:[{ms:1000,event:"fetchCatalog"}]`; `gateView({phase:"importing",cursor:10,total:100})` tiene barra con `value:0.1` y `every` con `importTick`. Título "Movie+".
- [ ] **Step 2: Run** FAIL → **implementar** `gateView` (3 fases + loading, patrón hdfull `999-1033`).
- [ ] **Step 3: Run** PASS.
- [ ] **Step 4: Test flujo de eventos del gate** (shims de catalog/storage):
  - `open` con `catalogCount()==0` → `{state:{ready:true, downloading:true}}`.
  - `download` → `{state:{downloading:true}}`.
  - `fetchCatalog` ok → guarda raw, fija `total`, `{state:{downloading:false, importing:true, cursor:0, total}}`; si falla → `{state:{...empty}, toast:{role:"error"}}`.
  - `importTick` hasta `done` → sale del gate a la vista normal (`ready:true`).
- [ ] **Step 5: Run** FAIL → **implementar** los manejadores en `screenEvent`.
- [ ] **Step 6: Run** PASS.
- [ ] **Step 7: Commit** `feat: HDFull-style catalog download+install gate`

---

### Task 8: Pantalla propia con barra superior estilo HDFull

**Files:**
- Create: `src/screen/index.js` (`screen`, `screenEvent`), `src/screen/view.js` (render puro)
- Modify: `src/plugin.js`
- Test: `test/screen.test.mjs`

**Interfaces:**
- Consumes: `catalog.js` (`CATEGORIES`, `recentByCategory`), `gate.js`.
- Produces:
  - `screen(arg): node` — si no hay catálogo/estado → `gateView`; si listo → `richView` (Scaffold + AppBar + TabBar + filas).
  - `screenEvent(ev): {state?|go?|close?|toast?}` — gate (Task 7) + `tab`, `open_search`/`search`/`close_search`, `refresh`, `open_settings`, `close_screen`.

- [ ] **Step 1: Test AppBar normal** (view puro): `richView({ready:true,tab:"peliculas",view:{...}})` tiene `appBar.type==="AppBar"`, `title:"Movie+"`, `mergeWithKinoBar:true`, `actions` con iconos `search`,`refresh`,`settings`, y `TabBar` con las 6 pestañas en orden (Películas, Series, Animes-Cartoons, Doramas, Duanju, Telenovelas).
- [ ] **Step 2–3:** FAIL → implementar `view.js` (AppBar normal + búsqueda con `TextField kind:"search"`, TabBar, filas de pósters cuyo `onPressed` = `{go:{title:{ref,kind,id,title}}}` → detalle nativo); PASS.
- [ ] **Step 4: Test eventos:** `screenEvent({name:"search",value:"batman"})` → `{go:{search:{q:"batman"}}}` (**búsqueda nativa**); `screenEvent({name:"tab",value:"series"})` → `state.tab==="series"`; `open_search`→`searching:true`. Test pestaña Duanju vacía → render sin romper. (Review Focus #4.)
- [ ] **Step 5–6:** FAIL → implementar `screen`+`screenEvent` (el `open` asegura identidad/sesión y cae al gate si el catálogo está vacío; tabs recargan; search hace `go.search`); PASS.
- [ ] **Step 7: Commit** `feat: branded Movie+ screen with HDFull-style top bar, native detail and search`

---

### Task 9: i18n, tema, refresco programado y validación end-to-end

**Files:**
- Create: `src/i18n.js`, `scripts/refresh` (`schedule`/`job` export), `panel-icon.png`
- Modify: `kino-plugin.json` (settings, schedule), `src/plugin.js`
- Test: `node sdk/validate.mjs .`, `node sdk/run.mjs . search "halo"`, `node sdk/run.mjs . screen`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `job()` (refresco de catálogo), textos es/en, settings (fuente/estado/limpiar caché).

- [ ] **Step 1: Test i18n** mínimos (clave→es/en). FAIL → implementar; PASS.
- [ ] **Step 2: Settings + schedule** en el manifest (refresco diario del catálogo con `job`).
- [ ] **Step 3: Build** `node scripts/build.mjs`.
- [ ] **Step 4: Validar** `node sdk/validate.mjs .` — Expected: PASS.
- [ ] **Step 5: Correr kit** `node sdk/run.mjs . search "halo"` devuelve ítems; `node sdk/run.mjs . screen` rinde el árbol con la barra. (Nota: la resolución real necesita red/servidor; usar fixtures o `--` según el kit.)
- [ ] **Step 6: Commit** `feat: i18n, theme, scheduled refresh, end-to-end validation`

---

## Self-Review

- **Cobertura del spec:** catálogo (T4), login RSA (T2+T3), películas (T5+T6), series (T5+T6), gate descarga/instalación (T7), pantalla Movie+ estilo HDFull (T8), detalle/búsqueda nativos (T6 refs + T8 `go`), categorías (T4), identidad única (T2), nombre Movie+ (T1), sin secretos (T1), apiVersion 14 (T1), refresco programado (T9). Cubierto.
- **Review Focus:** 401 (T3.7), URL caducada (T5.7), episodio sin SxxEyy (T5.4), Duanju vacío (T8.4), keygen cacheado (T2.5). Cada uno con test en su tarea dueña.
- **Consistencia de tipos:** refs `m:/s:/e:`, grants `catalog`/`catalog-value`, `signPkcs1/getIdentity/call/resolveToken/importCatalog(cursor)/gateView` usados con la misma firma en todas las tareas.
- **Proporción:** el plan fija interfaces, valores y tests; los cuerpos los escribe el implementador salvo la preimagen de firma y el parseo de episodios (algoritmos que el spec fija).
- **Gate de descarga (hdfull):** fases idle/downloading/importing con barra, import reanudable (T4.7, T7). Nombre Movie+ en manifest/screen/gate (T1, T7, T8).
