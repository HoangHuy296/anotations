# T157/T158 — merge TEXT routes/schemas into specs/api/openapi.yaml, validate

Date: 2026-09-24.

## Merge (T157)

Merged the *validated, as-implemented* TEXT routes/schemas into `specs/api/openapi.yaml`, not a blind copy of the pre-implementation design proposal (`specs/025-text-workspace-engine/contracts/openapi.yaml`, whose own `info.description` still says "Design contract only. Not implemented" -- accurate when written, stale now). Verified every shape against the real route handlers and the services/validators they call before documenting it; several field names differ from the design proposal (documented in the new schema file's header):

- `apps/web/src/app/api/assets/[assetId]/text/route.ts` (GET), `.../text/prepare/route.ts` (POST), `.../text/annotations/route.ts` (GET/POST), `apps/web/src/app/api/datasets/[datasetId]/text-policy/route.ts` (GET/PUT) -- all four routes added to `openapi.yaml` under a new `Text` tag.
- New `specs/api/schemas/text-annotations.yaml` -- TEXT-specific schemas (`TextSourceRead`, `TextGeometry` union, `TextAnnotation`, `TextMutationCommandEnvelope`'s six real commands, `TextPolicy`, etc.), derived from `text-source-read-service.ts`, `text-span-service.ts`, `text-command-service.ts`, `text-policy-service.ts`, `text-policy-write-service.ts`, and the `apps/web/src/lib/validation/text-*.ts` Zod schemas -- not from the design proposal's aspirational shapes (e.g. real `replaceClassification` uses `memberLabelIds`/`groupId` required, not the design's `labelIds`/nullable `groupId`; there is no `UpdateClassification` command in real code).
- **Genuine drift found and fixed in the *existing* generic `Annotation` schema** (`specs/api/schemas/annotations.yaml`), in scope because T157 explicitly depends on "T043 being final" (this session's fix adding `fromAnnotationId`/`toAnnotationId` to `SafeAnnotation`/`annotationSelect` for the generic reader): the documented `Annotation` schema was missing both fields entirely (`additionalProperties: false` would have rejected the real response). Added both as nullable, non-relation-always-null fields. Also added the three TEXT `AnnotationType` enum values (`NAMED_ENTITY_RECOGNITION`, `TEXT_CLASSIFICATION`, `TEXT_RELATION`) that the generic route can now return for TEXT assets.
- **Noted, not fixed, as a pre-existing broader gap outside 025's scope**: `AnnotationType`'s documented enum was already missing many VIDEO/AUDIO-only Prisma enum values (`SEGMENTATION_MASK`, `KEYPOINT`, `IMAGE_CLASSIFICATION`, `VIDEO_CLASSIFICATION`, `OBJECT_TRACK`, `ACTION`, `EVENT`, `SCENE`, `SHOT_BOUNDARY`, `POS_TAG`, `SENTIMENT`, `INTENT`, `TRANSCRIPT`, and others) before this feature touched the file -- documented inline in the schema's own description rather than silently left unexplained, but not comprehensively fixed here (that decision belongs to whoever owns the other Modality documentation passes, not a TEXT-feature closure).
- The generic `/api/assets/{assetId}/annotations` GET route's own documented response was **not** changed to add a `textPage`/richer-TEXT shape as the design proposal's `readGenericTextAnnotations` addition suggested -- checked the real route (`apps/web/src/app/api/assets/[assetId]/annotations/route.ts`) and it returns a flat `{annotations: SafeAnnotation[]}` for every modality, no TEXT-specific enrichment. Matching the design proposal here would have documented behavior that does not exist.

## Validate (T158)

```
$ pnpm run docs:validate-openapi
Checked specs/api/openapi.yaml against 80 actual route file(s).
Documented paths: 72
NOTE: Tags beyond the required set were declared: ['Collaboration', 'Text'] (only fail if unjustified by the route inventory).
NOTE: 8 actual route(s) are not documented in this pass (expected -- pre-existing exclusions, unrelated to TEXT)
OK: OpenAPI document is internally consistent and matches the route inventory.
```

Two real YAML syntax bugs were introduced while writing the new content and fixed before this run: an unquoted description containing `` `Cache-Control: private, no-store` `` (colon inside a plain scalar) in `openapi.yaml`, and four unquoted `pattern: ^sha256:...` regexes inside flow (`{ }`) mappings in `text-annotations.yaml` (a bare `:` is stricter inside flow mappings than in block style). Verified both files parse with `yaml.safe_load` before re-running the validator.

**Result**: PASS. All four new TEXT paths match their real route files exactly (path + method); the `/api/assets/{assetId}/annotations` GET+PUT assertion the validator specifically checks is unaffected.
