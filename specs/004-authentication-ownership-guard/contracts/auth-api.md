# Authentication API Contract

All endpoints are browser-facing application APIs. Inputs are validated before database work. Successful authentication uses HTTP-only cookies; response JSON never includes password, session credential, refresh credential, hash, encrypted value, provider token, or storage credential.

| Operation | Request | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | Email and password | `201`; safe current-user profile and authenticated cookie | `400` invalid input; `409` existing normalized email; safe error only |
| `POST /api/auth/login` | Email and password | `200`; safe current-user profile and authenticated cookie | `400` malformed input; `401` invalid credentials |
| `POST /api/auth/logout` | Current cookie, if present | `204`; active session revoked and cookie cleared | Idempotent `204` if cookie is absent/invalid, without session disclosure |
| `POST /api/auth/refresh` | Current valid HTTP-only cookie | `200`; safe current-user profile and rotated authenticated cookie | `401` absent, invalid, expired, revoked, or already-rotated session |
| `GET /api/auth/me` | Current HTTP-only cookie | `200`; safe current-user profile | `401` when no active session |

## Safe current-user profile

The profile returned by signup, login, refresh, and current-user is limited to the authenticated user's identifier, normalized email, display name, and safe application role. It excludes `passwordHash`, every AuthSession field, tokens, session hashes, IP address, and user-agent data.

## Cookie policy

- Cookies are HTTP-only and have restrictive same-site behavior.
- Secure-only transmission is enabled in production HTTPS deployments.
- Cookie lifetime must not exceed the active AuthSession expiry.
- Logout clears the cookie and revokes the server session.
- Refresh replaces the cookie and server hash; it never returns a credential to application JavaScript.
- State-changing auth requests verify same-origin request context in addition to cookie policy, and all auth responses use non-cacheable response semantics.
