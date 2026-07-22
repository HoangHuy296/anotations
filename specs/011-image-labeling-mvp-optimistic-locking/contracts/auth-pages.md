# Public Authentication Pages Contract

## Session model

Feature 011 uses the existing opaque HTTP-only cookie and server-managed
AuthSession record. It does **not** use JWT. Page code and browser storage never
receive a session token, refresh credential, password hash, or raw session
record.

## Public page behavior

| Visitor state | Login page | Registration page | Protected application page |
| --- | --- | --- | --- |
| No active session | show returning-user form | show account-creation form | redirect to login with a safe internal return target |
| Valid active session | redirect to safe authenticated destination | redirect to safe authenticated destination | allow normal authorization flow |
| Expired/revoked/invalid session | show public form after safe session denial | show public form | redirect to login; no protected data rendered |

## Form submission contract

- Registration submits email and password only to the existing registration
  boundary; login submits email and password only to the existing login
  boundary.
- Valid success establishes the existing HTTP-only session and redirects to a
  safe internal return target or default authenticated landing page.
- Invalid credentials, malformed form data, and duplicate registration produce
  safe actionable errors. Passwords are never reflected in page data.
- A form is pending while its request is in flight to prevent duplicate
  submission.

## Return-target safety

- A return target may be an internal relative application path only.
- It must begin with one slash, must not begin with two slashes, and must not
  contain a protocol/host interpretation.
- Invalid, absent, external, or malformed values use the default authenticated
  destination.
- The return target cannot grant authorization; the protected destination still
  resolves the active session and Dataset permission on arrival.

## Logout and denial

Logout keeps existing revocation behavior. Subsequent protected navigation
redirects to login; API calls receive the existing safe authentication-required
response. No denial response exposes whether another user/session exists.
