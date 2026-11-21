# Diseño — Plugin de Kino para MoviePlus

Fecha: 2026-11-20
Estado: borrador para aprobación

## Intención y porqué

Portar la fuente **MoviePlus** (app Android `com.dvex.movp`, backend `api.appsxploit.dev`)
a un plugin de Kino, reutilizando el cliente Python ya validado por ingeniería inversa.
El objetivo es que un usuario de Kino instale el plugin y tenga el catálogo completo de
MoviePlus (películas, series, anime/cartoons, doramas, telenovelas, duanju) con
reproducción directa, sin la app original, sin cuenta y sin el reproductor propietario.

El protocolo ya está completamente mapeado y probado: login anónimo con firma RSA,
catálogo en GitHub (gzip), y resolución de enlaces a URL directa de Yandex.

## Metas

- Catálogo navegable de las 6 categorías reales del menú de MoviePlus.
- Reproducción de **películas** y **series** (episodios) a URL directa.
- **Pantalla propia (`screen`)** como entrada de marca, con **barra superior estilo HDFull**.
- **Detalle de contenido = nativo de Kino** (no pantalla propia de detalle).
- **Búsqueda = buscador nativo de Kino** (la lupa de la barra entrega la consulta a Kino).
- Identidad única por instalación (clave RSA propia), como hace la app real.
- Última apiVersion que soporte el Kino del usuario (0.9.89 → hasta 27).

## No-metas

- **TV en vivo / canales / eventos:** MoviePlus NO lo tiene (es solo VOD, confirmado en
  código). No se implementa.
- Cuenta premium, login con email, favoritos/historial sincronizados con el servidor
  MoviePlus, descargas offline, comentarios de la comunidad. (Posibles fases futuras.)
- Pantalla de detalle propia: se usa la nativa de Kino.

## Anti-metas (qué sería un fracaso aunque "funcione")

- Compartir una sola identidad RSA entre todas las instalaciones (el servidor trataría a
  todos como un dispositivo → conflictos/rate-limit). Cada instalación genera la suya.
- Recargar el catálogo gzip (2.7 MB, 24.738 ítems) en cada llamada: tiene que indexarse una
  vez en `kino.catalog` (SQLite).
- Secretos en claro en `plugin.js`.

## Restricciones

- **Sandbox QuickJS de Kino:** sin RSA nativo. La firma RSA-2048 PKCS#1v1.5-SHA256 se hace
  a mano con `kino.crypto.hash("sha256", …)` + `kino.crypto.modPow(em, d, n)` (validado:
  firma idéntica a la de la librería y aceptada por el servidor).
- **Generación de la clave RSA:** `kino.crypto` no genera claves RSA. Hay que generar el par
  en JS puro (BigInt + Miller-Rabin) una vez por instalación y guardarlo en `kino.storage`.
  Es la pieza más pesada; ver Aproximación elegida y riesgos.
- `kino.fetch` solo llega a los `hosts` declarados, https, cuerpo ≤ 5 MB, ≤ 60 req por
  llamada. El catálogo gz (2.7 MB) entra en una sola petición.
- **Secretos:** si en el futuro hiciera falta uno, se sella con `sdk/seal.mjs`
  (`kino-sealed:v1:…` en el campo `secrets`), nunca en claro. *Hoy no se necesita ninguno.*

## Aproximaciones consideradas

1. **Plugin de fuente estándar (search/home/browse/episodes/resolve), UI 100% nativa.**
   Lo más simple. Descartado como entrega final porque el usuario quiere barra/entrada de
   marca estilo HDFull.
2. **Plugin con `screen` propio estilo HDFull + detalle y búsqueda nativos. ← ELEGIDA.**
   Pantalla de marca con barra superior (AppBar `mergeWithKinoBar`), pestañas por categoría
   y filas de pósters; cada póster abre el **detalle nativo** (`go.title`), y la lupa abre
   la **búsqueda nativa** (`go.search`). Combina identidad de marca con el detalle/episodios/
   reproductor nativos de Kino. Es el patrón exacto de `kino-plugin-hdfull`.
3. **Pantalla propia incluyendo detalle y reproducción dentro del `screen`.** Máximo control
   visual pero reimplementa lo que Kino ya hace bien (ficha, episodios, progreso, reproductor).
   Descartado: más trabajo, peor integración, el usuario pidió detalle y búsqueda nativos.

**Elegida: Aproximación 2.**

## Cómo se construye (decisiones tomadas)

### Estructura
- Carpeta `kino-plugin-movieplus/`, build modular `src/` → `plugin.js` con esbuild, igual que
  `kino-plugin-latino` (misma plantilla `sdk/`, `scripts/`, `test/`).
- apiVersion objetivo: la más alta soportada (hasta 27); `catalog`+`screen` requieren ≥ 14.

### Manifiesto (`kino-plugin.json`)
- `id`: `movieplus`. **`name`: `Movie+`** (nombre visible). `capabilities`: `home`, `browse`,
  `search`, `episodes`, `resolve`, `catalog`, `screen`, `schedule`. `streamHosts: "any"` (las
  URLs finales son de `*.yandex.net`/`yadi.sk` y pueden variar). `categories`: `["movies","series"]`.
- `hosts`: `api.appsxploit.dev`, `raw.githubusercontent.com`, `appsdevxp.com`,
  `developerxploit.com`, `yadi.sk`, `*.yandex.net`, `disk.yandex.com` (+ los que exija el
  resolver de Yandex).
- `screen`: `{ label:"Movie+", icon:"movie", menuOpens:"screen", opensFrom:["menu","settings"] }`.
- `theme`/`color`: rojo de Movie+ (acento ~ `#D80000`).
- `secrets`: **ninguno** (no se necesita).

### Descarga e instalación del catálogo (gate estilo HDFull)
Como `kino-plugin-hdfull`: el catálogo (24.738 ítems) se **descarga una vez y se instala** en
`kino.catalog`, con pantalla de progreso. En el evento `open` del `screen`, si
`kino.catalog.count() === 0`, se entra al gate con tres fases:
- **idle:** botón **"Descargar catálogo"** (`ElevatedButton onPressed:"download"`) + nodo de apoyo.
- **downloading:** `LinearProgressIndicator` indeterminado + `every:[{ms:1000,event:"fetchCatalog"}]`
  que baja el gz y lo guarda crudo en `kino.storage` (clave temporal), fija `importTotal`.
- **importing:** `LinearProgressIndicator` determinado `done/total` + `every:[{ms:1000,event:"importTick"}]`
  que hace `kino.catalog.upsert` por lotes (reanudable con un `cursor` en storage) hasta terminar.
Al terminar la importación se pasa a la vista normal (barra + pestañas). Un fallo de descarga
vuelve a idle con un toast "No se pudo descargar; reintenta". Refresco posterior por `schedule`/`job`
(diario) aplica deltas/versión nueva sin re-descargar todo si no cambió.

### Núcleo del protocolo (`src/movp/`)
- `crypto.js`: RSA por-instalación. Keygen BigInt (una vez, cacheada en `kino.storage`),
  SPKI DER (ASN.1) para el `installationId = "install_"+sha256(spki)`, firma PKCS#1v1.5
  vía `modPow`.
- `session.js`: `challenge → session(JWT) → bootstrap → auth guest`; guarda `sessionToken`,
  `grants{catalog,catalog-value}` y `deviceId`. Firma cada request `/v2/client/*` con el
  header `X-MOVP-Hybrid-Signature` (mensaje `MOVP-HYBRID-REQUEST-V1\n{MÉTODO}\n{path}\n
  {sha256(body)}\n{nonce}\n{sha256(sessionToken)}`), + `X-MOVP-App-Version(-Code)`.
- `catalog.js`: baja `items.json.gz`, indexa en `kino.catalog` (24.738 ítems) con el tipo,
  nombre, año, póster (`urlImage` TMDB), géneros. Refresco periódico.
- `resolve.js`:
  - Película: `movie-variants(movieId, grant catalog)` → variantes `calidad,_,tam,_,Movp2!token`
    → `playback(token, grant catalog-value, resolveProvider:true)` → URL directa.
  - Serie: `document(collection:"tv", documentId:seriesId, grant catalog)` → episodios
    `nombre_SPLIT_Movp2!token_SPLIT_tam[_FOLDER_carpeta]` → por episodio `playback(token)`.
    `issuedAtMs = floor(now/1000)*1000 - 1000`.

### Categorías (pantalla + browse) — mapeo confirmado (ActivityMain.java:415 + nk7.S)
| Pestaña | Tipos catálogo | Items |
|---|---|---|
| Películas | [1] | 16.855 |
| Series | [2] | 3.688 |
| Animes-Cartoons | [3,4] | 1.994 |
| Doramas | [6] | 1.801 |
| Telenovelas | [5] | 400 |
| Duanju | [7] | 0 (hoy vacío; se incluye) |

Orden en la barra, igual que la app: Películas, Series, Animes-Cartoons, Doramas, Duanju,
Telenovelas.

### Pantalla (`src/screen/`) — estilo HDFull
- `Scaffold` + `AppBar` `mergeWithKinoBar:true, dense:true`.
  - Normal: título "MoviePlus", `leading` cerrar, `actions` = lupa (buscar), refrescar, ajustes.
  - Búsqueda: `leading` atrás + `TextField kind:"search"`; al enviar → `go:{ search:{ q } }`
    (**buscador nativo de Kino**, que llama al export `search` del plugin).
- `TabBar` con las 6 categorías; cuerpo = filas de pósters por categoría/género.
- Cada póster: `onPressed: { go: { title: { ref, kind, id:<tmdbId>, title } } }` →
  **detalle nativo de Kino** (que a su vez usa `episodes`/`resolve` del plugin).
- La vista es pura (solo lee `state`); los datos los carga `screenEvent` (evento `open`).

### Contrato nativo (para detalle, episodios, búsqueda, Home)
- `search(query)`: busca por nombre en `kino.catalog` → ítems (película/serie) con ids.
- `home()`: filas destacadas (recientes por categoría) para el Home de Kino.
- `browse(...)`: paginado por categoría/género desde `kino.catalog`.
- `episodes(id)`: para una serie, baja el `document tv/{id}`, devuelve temporadas/episodios.
- `resolve(item)`: ejecuta el flujo de reproducción y devuelve el/los `Stream` con la URL
  directa y su calidad.
- Metadatos/pósters: `kino.tmdb()` / `kino.meta()` (sin llave propia).

### Identidad y estado
- `kino.storage`: clave RSA (PEM/JWK propio), `deviceId` (uuid), `installationId`,
  `sessionToken` + expiración, `grants`. Se renueva la sesión al expirar (~9 min).

## Resuelto en la revisión de constructor (hechos confirmados)

- **Cliente de referencia Python (funciona):** `/tmp/opencode/movieplus.py`,
  `test_standalone.py`, `test_series_doc.py`, `test_rsa_manual.py`. Son la fuente de verdad
  del protocolo (preimagen de firma, nombres de header/grant, shapes JSON). Hay que copiarlos
  al repo del plugin como referencia + vectores dorados (clave→mensaje→firma, y respuestas
  grabadas de challenge/session/bootstrap/auth/movie-variants/document/playback) para TDD
  offline.
- **Firma (exacta, validada):** `sha256` en **hex minúscula**; nonce = `uuid4` sin guiones
  (hex 32). Session: firma sobre `MOVP-HYBRID-SESSION-V1\n{JWT challenge}\n{deviceId}`.
  Request: header `X-MOVP-Hybrid-Signature` = base64(RSA-PKCS1v15-SHA256) sobre
  `MOVP-HYBRID-REQUEST-V1\n{MÉTODO}\n{path}\n{sha256hex(body)}\n{nonce}\n{sha256hex(sessionToken)}`.
- **#2 `id` del catálogo = id de TMDB** (confirmado: Halo=52814, Moon Knight=92749,
  El páramo=800410). `go.title { ref:<movpId>, id:<tmdbId==id>, kind }` abre el detalle nativo
  limpio; no hace falta matching por nombre/año.
- **#3 `playback(resolveProvider:true)` devuelve la URL final directa** (`mds.storage.yandex.net/rdisk/…`).
  `resolve` es una sola llamada; NO hace falta sub-resolver de Yandex. (`resolveProvider:false`
  daría el `yadi.sk/i/…` intermedio; no se usa.)
- **#4 Estructura del `document` de serie** (`tv/{tmdbId}`): `data` es un objeto
  `{ "Temporada NN/calidad": [ "<Nombre SxxEyy>.mkv_SPLIT_<Movp2!token>_SPLIT_<bytes>", … ] }`.
  Temporada y episodio se extraen con regex `S(\d+)E(\d+)` del nombre; la clave da calidad
  (720p/4K) para agrupar. `episodes(id)` es la numeración autoritativa.
- **#5 Keygen RSA-2048 viable:** spike en JS puro (BigInt + Miller-Rabin) = 0.337 s en Node;
  QuickJS ~5-15× más lento → ~2-5 s estimado, dentro del tope de ~20 s por llamada, y se hace
  **una sola vez** (cacheada en `kino.storage`). RSA-1024 (0.05 s) queda como plan B si una caja
  de TV real no llega. La firma por request (`modPow`) es trivial.

## Decisiones menores tomadas (mías)

- **apiVersion de piso: 14** (mínimo para `catalog` + `screen`), con *feature-detection* de lo
  aditivo (`mergeWithKinoBar`, etc.) en vez de declarar "27", que solo reduciría el conjunto de
  versiones de Kino compatibles.
- La keygen se dispara en el evento `open` del `screen` con fase "preparando" si hiciera falta
  tiempo; si no, de forma perezosa en la primera reproducción.

## Lo que queda a criterio del constructor

- Esquema exacto de tablas/índices en `kino.catalog` y tamaño de lote de importación.
- Estrategia fina de caché/TTL de sesión y de catálogo, y reintentos ante 401/expiración.
- Si la keygen RSA en JS resulta demasiado lenta en cajas de TV, plan B (ver riesgo).
- Textos/i18n (es/en) y detalles visuales del tema.
- Qué géneros/filas concretas mostrar en Home y en cada pestaña.

## Riesgos

- **Keygen RSA-2048 en QuickJS puede ser lenta** (buscar 2 primos de 1024 bits con BigInt).
  Mitigaciones: generarla una sola vez y cachearla; si excede el presupuesto de tiempo de una
  llamada, hacerlo dentro del `screen` (evento `open`) con barra de progreso, o evaluar
  RSA-1024 si el servidor lo acepta (a validar). La firma por request (`modPow`) es barata.
- **El catálogo depende de un repo GitHub de terceros** (`dev-mplus01/mplus01T`); si cae, hay
  espejos `appsdevxp.com`/`developerxploit.com`.
- **Caducidad de la URL de Yandex** (~minutos): resolver en el momento de reproducir, no antes.
- **Duanju vacío hoy**: la pestaña puede quedar sin ítems; mostrar estado vacío correcto.
