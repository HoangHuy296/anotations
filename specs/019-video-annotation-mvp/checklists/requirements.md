# Requirements Checklist: Video Annotation MVP

**Purpose**: Verify the Phase 019 specification is complete before planning.
**Created**: 2026-07-29  
**Feature**: [spec.md](../spec.md)

## Repository and architecture

- [ ] CHK001 Current `VideoObjectTrack`, `Annotation`, `VideoAsset`, and exact `AnnotationType` values are audited.
- [ ] CHK002 No replacement VideoTrack, VideoKeyframe, or VideoTemporalLabel model is proposed.
- [ ] CHK003 Shared workspace route, modality engine selection, PostgreSQL authority, private MinIO, and exact `{ jobId }` queue contract are preserved.
- [ ] CHK004 Migration/backfill impact is identified without creating a migration during specification.

## Revision and persistence

- [ ] CHK005 Track/keyframe mutations use only `VideoObjectTrack.revision`.
- [ ] CHK006 Standalone temporal-label mutations use only `Annotation.revision`.
- [ ] CHK007 Every successful mutation increments its owning revision exactly once in one atomic transaction.
- [ ] CHK008 Track/timestamp uniqueness, indexes, same-Dataset relationships, and deletion behavior are audited.
- [ ] CHK009 Interpolated geometry is derived and never persisted as an Annotation row.

## Validation and security

- [ ] CHK010 Timestamp, normalized bounding-box, temporal interval, property, and bounded-read validation is specified.
- [ ] CHK011 Foreign, malformed, unknown, cross-Dataset, non-VIDEO, stale, and duplicate requests have safe outcomes and no side effects.
- [ ] CHK012 Responses and UI projections exclude credentials, storage identity, provider/raw errors, queue internals, and filesystem paths.
- [ ] CHK013 Normal opaque-cookie authentication and existing permission matrix remain authoritative.

## User experience and tests

- [ ] CHK014 Video playback, timeline, track/keyframe, temporal-label, interpolation, autosave, and conflict behavior are independently testable.
- [ ] CHK015 Long-video reads are bounded by pagination or a time-window.
- [ ] CHK016 Regression coverage preserves Image Phase 017, Audio, imports, local-folder, and queue behavior.
- [ ] CHK017 Success criteria are measurable and completion requires reload persistence plus revision-conflict evidence.

## Notes

This checklist is intentionally unchecked because it gates implementation
planning and execution; checking items requires repository and runtime evidence.
