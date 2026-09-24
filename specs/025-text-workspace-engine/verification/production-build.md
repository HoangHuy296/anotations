# T165 — production build (domain → queue → web → worker)

Date: 2026-09-24.

```
$ pnpm run build
$ pnpm --filter @annotationplatform/domain build   # tsc -p tsconfig.json
$ pnpm --filter @annotationplatform/queue build    # tsc -p tsconfig.json
$ pnpm --filter @annotationplatform/web build      # next build (Turbopack)
▲ Next.js 16.2.9 (Turbopack)
✓ Compiled successfully in 19.0s
  Running TypeScript ...
  Finished TypeScript in 36.0s
✓ Generating static pages using 7 workers (26/26) in 543ms
$ pnpm --filter @annotationplatform/worker build   # tsc -p tsconfig.json
```

**Result**: PASS. All four packages built with no errors printed at any stage (no "Failed to compile" block, which Next.js always prints on a genuine build failure). The web route manifest includes every TEXT-specific route added this feature: `/api/assets/[assetId]/text`, `/api/assets/[assetId]/text/annotations`, `/api/assets/[assetId]/text/prepare`, `/api/datasets/[datasetId]/text-policy` — all correctly registered as dynamic (`ƒ`) server routes, none accidentally statically prerendered.
