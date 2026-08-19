#!/usr/bin/env node
// Generates a standalone, offline Swagger UI documentation page at
// specs/api/dist/index.html, backed by specs/api/dist/openapi.bundle.yaml
// (produced by scripts/bundle-openapi.py -- run that first).
//
// This is intentionally NOT a Next.js route: nothing under apps/web is
// touched, so this page can never ship in the production app bundle. It is
// a standalone static artifact meant to be opened directly from disk or
// served by any static file host, for sharing with colleagues.
//
// swagger-ui-dist is a root-level devDependency only (see package.json) --
// it is not a dependency of apps/web and is never imported by app code.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "specs", "api", "dist");
const bundlePath = path.join(outDir, "openapi.bundle.yaml");

if (!existsSync(bundlePath)) {
  console.error(
    "specs/api/dist/openapi.bundle.yaml is missing. Run `python3 scripts/bundle-openapi.py` first " +
      "(or `pnpm docs:build`, which runs both steps).",
  );
  process.exit(1);
}

const swaggerUiDistDir = path.dirname(require.resolve("swagger-ui-dist/package.json"));

// Only the assets an offline standalone page actually needs -- source maps
// and the ES-module bundle variants are dropped to keep the generated
// output small.
const assetsToCopy = [
  "swagger-ui-bundle.js",
  "swagger-ui-standalone-preset.js",
  "swagger-ui.css",
  "favicon-16x16.png",
  "favicon-32x32.png",
];

mkdirSync(outDir, { recursive: true });
for (const asset of assetsToCopy) {
  copyFileSync(path.join(swaggerUiDistDir, asset), path.join(outDir, asset));
}

const swaggerUiPackageVersion = require(path.join(swaggerUiDistDir, "package.json")).version;

const indexHtml = `<!doctype html>
<!-- GENERATED FILE -- do not edit by hand. Produced by scripts/generate-swagger-ui.mjs. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Fieldframe Annotation Platform API</title>
    <link rel="stylesheet" href="./swagger-ui.css" />
    <link rel="icon" type="image/png" href="./favicon-32x32.png" sizes="32x32" />
    <link rel="icon" type="image/png" href="./favicon-16x16.png" sizes="16x16" />
    <style>
      body { margin: 0; background: #fafafa; }
      .contract-banner {
        background: #1b1b1b; color: #f5f5f5; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 16px; text-align: center;
      }
      .contract-banner code { background: #333; padding: 1px 5px; border-radius: 3px; }
    </style>
  </head>
  <body>
    <div class="contract-banner">
      Standalone documentation build (swagger-ui-dist ${swaggerUiPackageVersion}) generated from
      <code>specs/api/openapi.yaml</code>. Not part of the production application --
      regenerate with <code>pnpm docs:build</code>.
    </div>
    <div id="swagger-ui"></div>
    <script src="./swagger-ui-bundle.js"></script>
    <script src="./swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: "./openapi.bundle.yaml",
          dom_id: "#swagger-ui",
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: "StandaloneLayout",
          deepLinking: true,
        });
      };
    </script>
  </body>
</html>
`;

writeFileSync(path.join(outDir, "index.html"), indexHtml);

console.log(`Generated Swagger UI documentation page: ${path.relative(repoRoot, path.join(outDir, "index.html"))}`);
console.log(`Open it directly in a browser, or serve specs/api/dist/ with any static file server.`);
