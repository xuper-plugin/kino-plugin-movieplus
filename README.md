# Kino plugin: Movie+

Películas y series de Movie+ en una pestaña de Kino, con pantalla propia y catálogo que se actualiza solo.

Estado: completo (catálogo, reproducción, pantalla, ajustes `maxQuality`/`catalogStatus` y refresco programado).
El catálogo es la copia liviana que un proceso automático regenera dos veces al día a partir del catálogo original de
Movie+ (9,4 MB descomprimido) y publica en la rama `data` de este repo (`items-light.json.gz`, ~1,1 MB; ~2,6 MB
descomprimido) y en el release `catalog`. Cada fila es `[tmdbId, tipo, fecha, título, póster, géneros]`; tipo 1 es
película (TMDB `/movie/{id}`) y cualquier otro es serie (TMDB `/tv/{id}`). Las versiones de video no van en el archivo:
se piden al servidor de Movie+ al reproducir.

El job `refresh` solo hace un HEAD a ese archivo y marca "actualización pendiente"; la pantalla descarga e importa la
copia nueva al abrirse (un job no puede usar `kino.catalog`).

## Desarrollo

```
npm install
npm run build       # src/plugin.js -> plugin.js
npm run validate    # build + node sdk/validate.mjs .
```

`icon.png` y `panel-icon.png` son marcadores copiados del plugin Latino; hay que reemplazarlos por el arte de Movie+.
La carpeta `sdk/`, `contract.json` y `kino.d.ts` vienen del kit de Kino (vía `kino-plugin-latino`).
