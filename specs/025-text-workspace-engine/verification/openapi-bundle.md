# T159 — regenerate the published OpenAPI bundle

Date: 2026-09-24.

```
$ pnpm run docs:bundle-openapi
Bundled 14 schema file(s), 184 schema(s) -> specs/api/dist/openapi.bundle.yaml
```

Picked up the new `schemas/text-annotations.yaml` file automatically (14 schema files, up from 13) and the 24 new TEXT-namespaced schemas plus the 2 fixed `annotations.yaml` fields, all mechanically rewritten from relative `$ref`s into the single global `#/components/schemas/<Name>` bundle form -- no manual editing of `dist/` (generated, gitignored, per `specs/api/README.md`).

**Result**: PASS.
