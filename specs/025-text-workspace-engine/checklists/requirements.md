# Specification Quality Checklist: TEXT Workspace Engine

**Purpose**: Validate specification completeness and quality before proceeding to planning.

**Created**: 2026-09-15

**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) in the product behavior design
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification beyond expressly required existing-platform constraints and later planning gates

## Notes

All 16 quality checks pass. This validates the specification, not the implementation. No application tests, database queries, migrations, live providers, browser acceptance, or production checks were executed for this specification-only task.

The brief expressly requires preserving named platform authorities and resolving Unicode/source/model/integrity/tokenization in later design documents. References to these constraints in Assumptions are intentional; no table layout, endpoint shape, implementation stack choice, tokenizer, offset unit, or new dependency has been selected here. G1–G5 are engineering planning gates, not unresolved product questions. All must be resolved before migration or durable annotation implementation.

### Validation and traceability

| Requirement coverage | Acceptance evidence in the spec |
| --- | --- |
| FR-001–008: shared shell, source readiness, details and capabilities | Story 1, Story 7; SC-001, SC-005 |
| FR-009–016: geometry, Unicode, taxonomy and metadata isolation | Story 2 and Edge Cases; SC-002, SC-003, SC-006 |
| FR-017–020: explicit document classification/cardinality/sentiment | Story 3; SC-001, SC-003, SC-004 |
| FR-021–024: relation identities, compatibility and deletion | Story 4; SC-003, SC-004 |
| FR-025–032: revisions, retries, autosave, workflow, Undo/Redo | Story 5; SC-004, SC-008 |
| FR-033–036: authorization, shared collaboration and revocation | Stories 1, 5 and 6; SC-007, SC-009 |
| FR-037–040: deterministic structure, accessibility and performance | Story 7; SC-002, SC-005, SC-006 |
| FR-041–046: privacy, configuration, exports, future AI boundary and regression | Stories 1/2/6, Edge Cases and G1–G5; SC-002, SC-007, SC-009 |

Validation pass 1 checked the supplied brief against seven stories, 46 requirements, nine outcomes, and five planning gates. Explicit defaults remove ambiguity around whitespace, overlap/duplicates, document scope, classification cardinality, relation direction/self/duplicate/cross-asset rules, endpoint deletion, and annotation-level review deferral. Scope preserves relations and classification as required delivery, even though implementation slices are ordered.

### Read-only repository findings for planning handoff

The active template resolved through `specify preset resolve spec-template` to `.specify/templates/spec-template.md` (core). Sequential numbering makes 025 the next feature directory. There was no `.specify/extensions.yml`, so neither pre- nor post-specification hooks apply; no branch was created. `.specify/memory/constitution.md` contains template placeholders, not adopted principles; AGENTS.md and the locked architecture remain the governance source.

These are source-audit findings, not claims about the contents of a running deployment. The full runtime/source inventory belongs in research under G2.

| Area inspected | Current evidence | Consequence for planning |
| --- | --- | --- |
| Shared engine and shell | `apps/web/src/lib/workspace/workspace-engine-registry.tsx`, workspace engine, header, sidebar, properties panel, and asset navigator already dispatch per engine | Extend the registered TEXT engine; do not create a shell or route family. |
| TEXT surface | `components/workspace/text-engine.tsx` is a placeholder; `text-toolbox.tsx` imports the image store and exposes a bounding-box tool | Replace inert/image-only controls through text capabilities. |
| TEXT selection/details | `lib/workspace/workspace-read.ts` and `types/workspace.ts` expose filename, MIME type, byte size, optional text length and language, but no source text, text annotations, or selected TEXT status/revision fields | Add a safe complete selection contract; metadata alone is not an annotatable document. |
| TEXT properties | `placeholder-properties-tabs.tsx` shows real partial metadata and disabled tabs, lacks a completed TEXT properties editor, and only flushes image/video saves | Fill the existing panel and integrate text save/navigation behavior. |
| Source storage | `prisma/schema.prisma` has nullable `TextAsset.content`, language, tokenization, and metadata; `lib/asset-upload.ts` and `worker/jobs/repository-asset-upsert.ts` create TEXT child metadata beside MinIO-backed assets | Resolve legacy content versus source-object authority; do not infer that the optional content column is populated. |
| Source validation/read | `lib/upload-verification.ts` checks a bounded UTF-8 prefix and does not derive full text length; the generic asset view-url route issues an authorized scoped capability, not a canonical text read contract | Full-source decoding/identity/size validation is a planning requirement. Preserve the brief's stricter source-content privacy requirement. |
| Annotation domain | Generic `Annotation` includes geometry, revision, properties, `startChar/endChar`, token/sentence fields, `textValue`, and relation references; label scopes include ENTITY/CLASSIFICATION/RELATION/SENTIMENT | Compare existing generic capabilities before adding any text table. Define canonical geometry versus optional projections; existing relations do not prove same-asset/duplicate/deletion policy. |
| IMAGE/VIDEO patterns | Image mutation service uses revision predicates; video keyframe service also coordinates track revisions; workflow content helpers guard the parent asset revision/freeze | Reuse invariants, not an assumed identical mutation implementation. AI prediction writers also affect reviewable content and need regression coverage if shared helpers change. |
| Workflow | `lib/workflow/asset-workflow-service.ts` uses existing Asset status/revision, freezes review/rejected states, and records OPEN_REVIEW without a new state | Preserve Start/Submit/Review/Approve/Reject/Rework semantics; no TEXT workflow. |
| Autosave/shared actions | `workspace-header.tsx` reads image save state and explicitly flushes image/video; shared navigation has the same two-engine coupling | Add a bounded active-engine save/flush integration and check flush outcomes/current parent revision before Submit. |
| Keyboard | `use-workflow-shortcuts.ts` reserves unmodified `s` for Submit and `a` for Approve, suppressing editable targets and marked annotation interactions | TEXT selection/inspector/search interactions must not trigger those actions accidentally. |
| Collaboration | Existing authorization, collaboration outbox/notification services and workflow integration are dataset/asset scoped | Reuse typed Responsibilities, Discussion, Activity and durable notifications; do not invent TEXT membership or event authority. |
| Presence | `use-workspace-presence.ts` observes input/textarea/contenteditable/canvas interactions; a normal text renderer is not automatically an editing surface | Extend only the safe activity signal; never transmit source text or ranges. Presence is not a lock. |
| Annotation review | Schema has annotation statuses/reviewer fields, but the audited flows do not establish a complete TEXT-level review contract | FR-031 explicitly defers standalone annotation-level review rather than treating it as asset approval. |
| Deterministic NLP structure | Audited source paths create empty tokenization metadata; no authoritative text tokenizer/segmentation pipeline was found in those paths | Do not interpret metadata field availability as implemented tokenization; resolve G5 or defer durable indexes. |
| Infrastructure/contracts/proof | Existing private worker/Job transport, MinIO source storage, Prisma schema, realtime delivery and `specs/api` documentation already exist; integration suites have explicit environment gates and known gaps | Reuse the existing boundaries. Planning must list native commands and real runtime evidence; no test skips count as passing proof. |

### IMAGE/VIDEO assumption classification

A = valid modality-specific logic; B = already modality-neutral or registry based; C = concrete integration blocker. Classification concerns actual behavior, not merely the appearance of a modality string.

| Classification | Occurrences/areas | Disposition |
| --- | --- | --- |
| A | Image/video renderers, image geometry/mutations, video tracks/keyframes/temporal labels and media readiness | Keep specialized behavior within those engines. TEXT geometry must not extend the spatial canvas. |
| A | `ai-detect-dialog.tsx`, AI task/model/detect services and types, worker `aioz-task-resources.ts` | IMAGE/VIDEO-only AI execution is an intentional existing capability. Manual TEXT must not extend these providers. |
| A | Provider file mapping in `gitea.client.ts`, `provider.types.ts`, worker repository import source; retry modality typing | These already recognize other supported modalities; no text-specific public backend is justified. |
| B | `workspace-engine-registry.tsx`, engine dispatch, sidebar engine labels, asset-browser filters, dataset validation/overview and asset navigator | Existing entries/enums include TEXT; preserve common navigation and filter semantics. |
| B with C projection gap | `workspace-read.ts` / `types/workspace.ts` | Dispatch already supports TEXT, but its selection DTO lacks the editable engine's required source/annotation/revision context. |
| C | `text-toolbox.tsx` image-store coupling and bounding-box control | Introduce only actual text tools/capabilities. |
| C | `workspace-header.tsx`, `properties-panel.tsx`, `placeholder-properties-tabs.tsx` image/video save-state/flush coupling | Include active TEXT save/dirty/conflict/flush outcomes in shared actions without another scattered modality chain. |
| C | TEXT placeholder tabs/status fields and current Presence interaction detection | Complete the existing text panel/status integration and safe editing awareness. |

The earlier [repository review](../../../docs/code-review-2026-09-12.md) records pre-existing AI lifecycle, upload validation, test-gating, and documentation concerns. It is context only; planning must reassess affected paths and report baseline failures separately. This specification does not authorize unrelated fixes or reopen Phase 024 invitation-link approval gates.
