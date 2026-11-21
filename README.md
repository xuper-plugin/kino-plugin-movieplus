# Kino plugin: Movie+

Películas y series de Movie+ en una pestaña de Kino, con pantalla propia y catálogo que se actualiza solo.

Estado: completo (catálogo, reproducción, pantalla, ajustes `maxQuality`/`catalogStatus` y refresco programado).
El job `refresh` solo hace un HEAD al espejo del catálogo y marca "actualización pendiente"; la pantalla descarga e
importa la copia nueva al abrirse (un job no puede usar `kino.catalog` ni leer ~9 MB).

## Desarrollo

```
npm install
npm run build       # src/plugin.js -> plugin.js
npm run validate    # build + node sdk/validate.mjs .
```

`icon.png` y `panel-icon.png` son marcadores copiados del plugin Latino; hay que reemplazarlos por el arte de Movie+.
La carpeta `sdk/`, `contract.json` y `kino.d.ts` vienen del kit de Kino (vía `kino-plugin-latino`).
