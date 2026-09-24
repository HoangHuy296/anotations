# Requested structured text import extension

Recorded 2026-09-21. User confirmed initial formats: **TXT, CSV, JSON, JSONL**.

This extends the existing Phase 025 specification, which currently treats CSV/JSON as whole source documents and excludes structured record import. It is recorded here for the next specification/planning pass; no importer implementation or new schema is claimed by the reader phase.

## Required flow

1. Authorize upload into a Dataset and store the original file privately in MinIO using the existing upload boundary.
2. Detect and validate the selected file format, independently of its extension.
3. Parse content using bounded worker processing backed by the common PostgreSQL Job; BullMQ carries only `{jobId}`.
4. Decode the declared/detected supported encoding strictly and produce immutable UTF-8 document sources. Never silently replace undecodable characters.
5. Split structured records into documents where the format/mapping requires it.
6. Validate required text columns/fields before creating document assets.
7. Extract supplied entity spans, classifications, sentiment, relation references, and label metadata through an explicit format mapping.
8. Persist document metadata using the existing Dataset → Asset(TEXT) → TextAsset model, with source bytes in MinIO. “TextDocument” describes the product concept; a duplicate document table is not assumed.
9. Persist imported labels using the canonical Annotation model and Annotation.geometry; do not introduce a parallel TextAnnotation authority.
10. Return a safe summary containing accepted/rejected document and annotation counts, duplicate/retry outcomes, and actionable row-level validation errors without source excerpts or private storage locators.

## Proposed format mapping to specify before implementation

- TXT: one document per file.
- CSV: mapped text column, optional stable document identifier and annotation fields; support quoted delimiters, embedded newlines, and explicit required-column validation.
- JSON: explicitly mapped document object or document array; validate the selected record path and fields.
- JSONL: one mapped document object per nonblank line, with line-numbered validation errors.

These mappings are proposals, not an assertion that arbitrary third-party annotation schemas are supported.

## Invariants and acceptance criteria

- Freeze the normalized document text before computing source identity, boundaries, or accepting annotations. Imported ranges must address that exact text.
- Declare incoming offset units. Convert only through a verified mapping; reject ambiguous byte/code-point/token offsets instead of guessing. Canonical character geometry remains original-source UTF-16 offsets.
- Never derive canonical ranges from browser layout, displayed lines, CSS, or scroll position.
- Token/sentence/paragraph references require explicit deterministic metadata; absence must remain visible rather than inventing indices.
- Span edits preserve label metadata, status, color, confidence, custom properties, and relation identity unless explicitly changing those fields.
- Classification uses document scope; relations resolve valid annotation identities within the same document/source.
- Duplicate delivery or a retry must not duplicate documents, labels, or annotations. Reuse the existing guarded/revisioned annotation services and common Job lifecycle.
- Define bounded file/document/record sizes, schema validation, failure atomicity, cancellation, and retry behavior before rollout.
- Test all four formats, malformed records/encoding, Unicode offset conversions, missing columns, invalid label/relation references, permission loss, and duplicate delivery.

The next existing implementation checkpoint remains Phase 4 / US2 (manual span/entity CRUD). This import extension must be specified and sequenced without skipping the remaining text-workspace phases.
