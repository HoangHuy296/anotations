# ADR 0009: Strategy-Based Annotation Exports

- Status: Accepted
- Date: 2026-06-23

## Context

V1 needs JSON and CSV, while COCO, YOLO, and Pascal VOC are planned. Embedding
format branches in a Route Handler would couple transport, querying, and file
generation.

## Decision

Define an `ExportStrategy` contract for format identity, validation,
generation, content type, and filename. Query one canonical export dataset,
then delegate serialization to the selected strategy. Store artifacts through
`StorageProvider`, track them through `ExportJob`, and download through an
authorized Route Handler.

## Consequences

Formats can be added independently and tested against the same canonical
input. Format-specific validation remains inside each strategy. Export job
state, retention, and failure cleanup must be consistent across strategies.
