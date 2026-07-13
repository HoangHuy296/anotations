# ADR 0002: Server and Client Component Boundaries

- Status: Accepted
- Date: 2026-06-23

## Context

The app combines sensitive server data with a highly interactive canvas.
Marking broad component trees as client code would increase JavaScript cost
and risk importing server-only modules into browser bundles.

## Decision

Pages and layouts remain Server Components by default. They load initial
database data and pass serializable DTOs to narrow Client Components. Forms,
browser APIs, Zustand, keyboard handling, and Konva define client boundaries.
Server Actions are used for form-oriented same-origin mutations; canvas,
import, image, and export workflows use Route Handlers.

## Consequences

Client bundles stay smaller and secrets remain server-side. DTO boundaries
must be explicit and serializable. Interactive components cannot directly
import Prisma, Gitea, storage implementations, or environment readers.
