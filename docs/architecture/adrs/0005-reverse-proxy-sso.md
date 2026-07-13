# ADR 0005: Reverse-Proxy SSO Trust Boundary

- Status: Accepted
- Date: 2026-06-23

## Context

Production APIs require an authenticated identity, but adding an application
authentication framework conflicts with the current dependency and phase
constraints. The deployment can provide SSO at a trusted gateway.

## Decision

The public edge strips client-supplied identity headers and the trusted reverse
proxy injects the canonical subject and email headers. Next.js rejects
protected requests without valid identity, maps identity to `User`, and
performs role and resource authorization. The application origin must not be
publicly reachable around the proxy.

## Consequences

Authentication remains outside the app while authorization remains inside it.
Deployment configuration is security-critical and must be documented and
tested. Local development needs an explicit safe identity simulation that is
disabled in production.
