# ADR 0008: Konva Interaction and State Model

- Status: Accepted
- Date: 2026-06-23

## Context

Pointer movement, dragging, and transforms are high-frequency operations.
Updating React or network state for every event would cause rerenders, request
storms, and poor canvas responsiveness.

## Decision

Persist geometry in image coordinates and keep viewport transforms separate.
Use Konva nodes and refs for transient interaction state. Commit one normalized
Zustand action only on draw completion, drag end, transform end, delete, or an
explicit property change. Persist after those semantic boundaries. Represent
undo/redo as bounded semantic actions.

## Consequences

Canvas interactions remain responsive and persistence is predictable.
Coordinate conversion and normalization become critical tested utilities.
Optimistic updates need canonical server reconciliation and stale-request
handling when images change.
