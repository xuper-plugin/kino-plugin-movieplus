#!/usr/bin/env node
// Bundles src/plugin.js (and everything it imports) into the single plugin.js Kino loads.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(ROOT, "src/plugin.js")],
  bundle: true,
  format: "esm",
  target: "es2020",
  outfile: resolve(ROOT, "plugin.js"),
  logLevel: "info",
});
