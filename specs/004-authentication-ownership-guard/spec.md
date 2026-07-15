# Feature Specification: Authentication + Ownership Guard

**Feature Branch**: `004-authentication-ownership-guard`  
**Created**: 2026-07-13  
**Status**: Draft  
**Input**: User authentication, session lifecycle, and ownership authorization for Fieldframe data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and use an account (Priority: P1)

As a new or returning user, I need to register and sign in securely so that I can use my private Fieldframe workspace.

**Why this priority**: A reliable identity is the prerequisite for every private workspace and ownership decision.

**Independent Test**: A user can create an account, sign in with the same credentials, retrieve their current identity, and receive no authenticated identity after signing out.

**Acceptance Scenarios**:

1. **Given** an unused valid email address and valid password, **When** a visitor signs up, **Then** the system creates one account and establishes an authenticated session without returning secret credentials in the response body.
2. **Given** valid account credentials, **When** a visitor signs in, **Then** the system establishes an authenticated session and identifies that user as the current user.
3. **Given** invalid credentials or an email already in use, **When** a visitor attempts to sign up or sign in, **Then** the system safely rejects the request without revealing account-sensitive details beyond what is necessary to correct the request.
4. **Given** an authenticated user, **When** they request their current identity, **Then** the system returns only their safe profile information.

---

### User Story 2 - Maintain and end a session safely (Priority: P1)

As an authenticated user, I need my session to continue securely while valid and to end completely when I sign out.

**Why this priority**: Users need a predictable sign-in experience without allowing stale, revoked, or stolen session credentials to remain usable.

**Independent Test**: A valid session can be refreshed, a signed-out session cannot be refreshed or used for protected access, and expired sessions are denied.

**Acceptance Scenarios**:

1. **Given** a valid, active session, **When** the user refreshes the session, **Then** the system issues a replacement session credential and invalidates the credential being replaced.
2. **Given** a revoked, expired, malformed, or missing session credential, **When** a user requests refresh or a protected resource, **Then** the system denies access and does not establish a new authenticated session.
3. **Given** an authenticated user, **When** they sign out, **Then** the system revokes the active session and subsequent current-user, refresh, and protected-resource requests are unauthenticated.

---

### User Story 3 - Access only authorized workspace data (Priority: P1)

As a dataset owner or member, I need to access only the datasets and related work I am permitted to see or change.

**Why this priority**: Fieldframe contains private source content and annotation work; identifier guessing must never become an access method.

**Independent Test**: Create two users with separate datasets, then verify one user cannot read, change, or create work against the other user's Dataset, Asset, Label, Annotation, or Job.

**Acceptance Scenarios**:

1. **Given** a dataset owner, **When** they access a protected dataset resource or permitted action, **Then** access is granted according to the owner role.
2. **Given** a dataset member, **When** they access a protected dataset resource or permitted action, **Then** access is granted only when their membership role permits that action.
3. **Given** a non-member, **When** they supply another user's Dataset, Asset, Label, Annotation, or Job identifier, **Then** the system gives a safe denial, returns no protected metadata, and creates no side effect.
4. **Given** a browser request with a forged owner or actor identifier, **When** it attempts a protected mutation, **Then** the server derives the actor from the authenticated session and ignores the supplied ownership value.

### Edge Cases

- A user attempts to register with an email that differs only by normalization or casing from an existing account.
- A password fails the product's required strength policy or is absent.
- A user has several active sessions and signs out from one of them.
- A refresh request repeats an already-rotated credential, or two refresh requests arrive concurrently.
- A user is removed from dataset membership while a browser page is open.
- A dataset, related resource, or session is deleted, archived, revoked, or expires between authorization and action.
- A request supplies an ownership field, identity header, cookie value, or resource identifier intended to impersonate another user.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a visitor to register one account with a unique normalized email address and a valid password, and MUST never persist a plaintext password.
- **FR-002**: The system MUST allow a registered user to sign in with valid credentials and reject invalid credentials safely.
- **FR-003**: The system MUST provide the following browser-facing authentication operations: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/refresh`, and `GET /api/auth/me`.
- **FR-004**: Successful sign-up, sign-in, and refresh MUST establish authentication using cookies unavailable to browser scripts; authentication credentials, password material, and session secrets MUST never appear in browser-readable state, URLs, logs, error messages, or queue payloads.
- **FR-005**: Refreshing an active session MUST rotate its refresh credential, invalidate the replaced credential, and preserve no more authority than the active user's existing session.
- **FR-006**: Signing out MUST revoke the active session and clear its browser authentication state. A revoked, expired, malformed, or missing session MUST be treated as unauthenticated.
- **FR-007**: Current-user responses MUST identify only the authenticated user's safe profile fields and MUST not disclose password, session, refresh-token, or secret fields.
- **FR-008**: All private pages and protected browser-facing operations MUST require an authenticated session before accessing protected metadata or performing a mutation.
- **FR-009**: Dataset access MUST require the dataset owner or an active DatasetMember role. Permission decisions MUST distinguish owner, manager, reviewer, and labeler capabilities for each protected action.
- **FR-010**: Asset, Label, Annotation, and Job access MUST be authorized through the related dataset and authenticated actor; possession of any resource identifier alone MUST not grant access.
- **FR-011**: The backend MUST derive ownership and creator fields from the authenticated actor. It MUST ignore or reject user-supplied owner, creator, member, or actor identifiers when they conflict with server-derived authorization.
- **FR-012**: An unauthorized request MUST not disclose protected metadata and MUST not create, alter, enqueue, cancel, or delete any durable record, queue message, or binary object.
- **FR-013**: A permitted Job creation MUST record the authenticated creator, preserve the Dataset relationship, and retain PostgreSQL as the authoritative Job lifecycle record.
- **FR-014**: This phase MUST use the existing User, AuthSession, Dataset, DatasetMember, Asset, Label, Annotation, and Job data structures. Any schema or migration change requires separate approval.

### Key Entities

- **User**: A registered Fieldframe account, identified by a unique email address.
- **Authenticated session**: A revocable, expiring record that proves a browser request belongs to a User.
- **Dataset**: The private workspace boundary owned by one User and shared only with authorized members.
- **Dataset membership**: A User's role-limited entitlement to a Dataset they do not own.
- **Asset, Label, Annotation, and Job**: Protected records whose access is determined through their Dataset relationship and the authenticated actor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance testing, 100% of valid new-user registrations and valid sign-ins establish an authenticated current-user identity within 5 seconds under normal local operating conditions.
- **SC-002**: In acceptance testing, 100% of logout, expired-session, revoked-session, and invalid-session cases deny subsequent protected access.
- **SC-003**: In authorization testing, 100% of attempted cross-user accesses to Dataset, Asset, Label, Annotation, and Job resources return no protected resource data and make no durable change.
- **SC-004**: In authorization testing, 100% of permitted owner and member actions succeed only for the role capabilities assigned to that user.
- **SC-005**: In response and log review, 0 authentication credentials, password values, refresh credentials, or server-only secrets are exposed to browser-readable state, URLs, logs, errors, or queue messages.

## Assumptions

- This phase provides email-and-password account authentication; external identity providers, password reset, email verification, multi-factor authentication, account recovery, and organization-wide administration are out of scope.
- Session credentials are held only in secure HTTP-only cookies. The browser does not receive or store an authentication token in application state.
- Existing User and AuthSession fields are sufficient for the defined lifecycle. No schema or migration change is included.
- A Dataset's owner has owner capabilities. DatasetMember roles define the additional authorized capabilities; the exact action-to-role matrix will be established in implementation tests and documentation without widening access beyond owner, manager, reviewer, and labeler.
- This phase implements authentication and authorization only. It does not implement repository cloning, binary transfer, Job processing, or a new workspace modality.
