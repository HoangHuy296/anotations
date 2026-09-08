# Feature Specification: Collaboration Platform

**Feature Branch**: `024-collaboration-platform`

**Created**: 2026-09-04

**Status**: Draft

**Input**: User description: "Extend the existing dataset workspace with governed membership, typed asset assignments, threaded discussion, durable notifications, realtime delivery, and lightweight presence, while retaining the Phase 023 annotation review workflow."

## Baseline versus additive extension

**Phase 024 baseline (already established)**: recipient-specific `DatasetInvitation`, `DatasetMember` role authorization, typed assignments, discussion, durable notifications/Bell, transactional outbox with private-worker relay, Redis fan-out, delivery-only realtime tickets/gateway, membership revocation/reconnect convergence, Presence, and the Discussion/Activity workspace integration.

**Additive extension (planned, not implemented)**: shareable invitation links. It adds only `share-link -> authenticated explicit claim -> existing DatasetMember`; it does not replace the recipient-specific invitation flow or alter any established baseline authority, UI, gateway, or workflow behavior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Dataset Members and Roles (Priority: P1)

A dataset Owner or permitted Manager can see who participates in a dataset, invite a colleague, adjust an eligible colleague's role, or remove them so that people can collaborate with clear responsibilities.

**Why this priority**: Membership is the authorization foundation for every other collaboration capability.

**Independent Test**: An Owner can invite a Labeler and Reviewer, see them in the member directory, change an eligible role, and remove a member; removed users immediately lose access to the dataset.

**Acceptance Scenarios**:

1. **Given** an authorized member manager and a valid user identity, **When** they invite that user with an eligible role, **Then** the recipient has a pending invitation and does not become an active dataset member until they accept it.
2. **Given** a member directory, **When** an Owner or eligible Manager changes an eligible member's role, **Then** subsequent server-side requests use the new role immediately.
3. **Given** a member who has dataset access, **When** an authorized actor removes them, **Then** incompatible active assignments are removed, existing realtime subscriptions are revoked or re-authorized, the member disappears from the directory, and later requests are concealed or refused according to existing dataset-access behavior.
4. **Given** a Labeler or Reviewer, **When** they attempt to invite, remove, or change a member, **Then** the request is rejected server-side.

---

### User Story 2 - Assign Annotation and Review Work (Priority: P1)

A Manager or Owner assigns an asset to a Labeler for annotation and independently assigns it to a Reviewer for review, then can reassign or unassign either responsibility without altering the asset's workflow state.

**Why this priority**: Assignment turns membership into actionable, visible work ownership while keeping Phase 023's lifecycle intact.

**Independent Test**: On one asset, an authorized manager assigns a Labeler and a Reviewer, reassigns one responsibility, unassigns the other, and verifies that no assignment action changes annotations or the asset workflow status.

**Acceptance Scenarios**:

1. **Given** an active dataset Labeler, **When** an authorized manager assigns annotation work for an asset, **Then** the active annotation assignment is visible to authorized dataset members and the assignee receives a notification.
2. **Given** an active dataset Reviewer, **When** an authorized manager assigns review work for an asset, **Then** the active review assignment is independent from any annotation assignment and the assignee receives a notification.
3. **Given** an asset with an active responsibility assignment, **When** an authorized manager reassigns or unassigns it, **Then** the previous active assignment is no longer presented as active, an attributable assignment-history entry is retained, and the asset's workflow state remains unchanged.
4. **Given** a user who is not an active, eligible dataset member for the target responsibility, **When** an assignment is requested for them, **Then** the request is rejected without creating a partial assignment.

---

### User Story 3 - Discuss an Asset in Threads (Priority: P1)

Dataset collaborators discuss a selected asset in a dedicated Discussion Drawer, reply in threads, mention colleagues, resolve completed threads, and manage their own comments without confusing discussion with review feedback or the Properties Panel.

**Why this priority**: Conversation provides the context needed for people to collaborate before, during, and after the existing annotation-review workflow.

**Independent Test**: Two authorized members create a root comment and reply, mention a third member, resolve the thread, and verify that the discussion is visible independently of the Properties Panel and review history.

**Acceptance Scenarios**:

1. **Given** an authorized dataset member viewing an asset, **When** they open Discussion, **Then** a right-side drawer shows that asset's discussion without replacing the Properties Panel.
2. **Given** a comment thread, **When** an authorized member replies or mentions an active dataset member, **Then** the reply is associated directly with its root comment (reply depth never exceeds one) and each valid mentioned user other than the actor is notified once.
3. **Given** a comment authored by the current user, **When** they edit or delete it, **Then** the change is retained in the thread according to the product's visible deleted-comment behavior and no other user's comment is changed.
4. **Given** a resolved thread, **When** an authorized participant reopens the drawer, **Then** its resolved state and resolver remain visible; resolving a thread never changes review feedback or Asset.status.

---

### User Story 4 - Receive Durable Collaboration Notifications (Priority: P1)

A user can see unread and historical in-app notifications for invitations, assignments, mentions, replies, and review outcomes, mark them read, and navigate directly to the relevant asset and discussion.

**Why this priority**: Collaboration remains reliable when a user is offline or reconnects later.

**Independent Test**: Create an assignment, mention, reply, and review decision while the recipient is offline; when they return, all notifications are visible, can be marked read, and deep-link to the correct context.

**Acceptance Scenarios**:

1. **Given** a collaboration action that affects a recipient, **When** it succeeds, **Then** the recipient has one durable notification with an actor, type, timestamp, and safe dataset/asset context.
2. **Given** unread notifications, **When** the recipient opens the Bell in the global or workspace header, **Then** they can distinguish unread from read entries and mark one or all as read; the badge shows the unread count, caps its visual text at `99+`, and is absent when the count is zero.
3. **Given** a notification tied to an asset or comment, **When** the recipient opens it, **Then** the workspace opens the correct dataset and asset and, where applicable, the referenced discussion thread.
4. **Given** a user without access to the related dataset, **When** they request notifications or follow a notification link, **Then** inaccessible context is not disclosed.

---

### User Story 5 - See Timely Collaboration Updates (Priority: P1)

Connected collaborators receive timely signals that discussion, membership, assignment, notification, or workflow-related activity changed, while all authoritative reads and mutations remain governed by the existing application behavior.

**Why this priority**: Timely awareness makes the collaboration experience feel shared without weakening existing authorization or durability guarantees.

**Independent Test**: Two authorized browser sessions on the same dataset observe a new comment, assignment, and notification promptly; both can refresh and retrieve the same authoritative result after a reconnect.

**Acceptance Scenarios**:

1. **Given** two connected authorized members, **When** one creates, edits, deletes, resolves, assigns, or changes membership, **Then** the other receives a timely indication that the relevant view changed. The actor does not receive a duplicate self-notification for their own action.
2. **Given** a disconnected recipient, **When** an event occurs, **Then** reconnecting does not lose durable notifications or discussion activity.
3. **Given** a malformed, unauthorized, or stale client command, **When** it is submitted, **Then** it is rejected by the authoritative command boundary and is not broadcast as a successful collaboration event.
4. **Given** a realtime transport interruption, **When** the browser reconnects, **Then** it refreshes authoritative collaboration data rather than treating transient delivery data as the source of truth.

---

### User Story 6 - See Lightweight Presence (Priority: P2)

Users viewing a dataset or asset can see a lightweight avatar stack and details showing who is viewing or editing, helping them coordinate without blocking either person's work.

**Why this priority**: Presence is valuable awareness, but collaboration remains functional without it and it depends on the realtime foundation.

**Independent Test**: Two users open the same asset; each can see the other's viewing/editing indication, and a closed browser session disappears after its heartbeat expires.

**Acceptance Scenarios**:

1. **Given** authorized users viewing the same dataset or asset, **When** they connect or change their activity, **Then** other authorized viewers see current lightweight presence details.
2. **Given** a user begins or stops editing an asset, **When** their presence changes, **Then** the activity indicator updates without changing annotations, assignments, or workflow state.
3. **Given** a browser closes or stops sending heartbeats, **When** its presence expires, **Then** it no longer appears as online without requiring a durable cleanup action.
4. **Given** Alice is editing and Bob is viewing the same asset, **Then** Bob remains able to view and use all server-authorized actions. **PRESENCE IS NOT A LOCK.**

---

### User Story 7 - Use Collaboration Without Losing Workspace Context (Priority: P2)

A workspace user can access discussion, presence, notifications, and activity alongside the existing header, engine, Properties Panel, and Phase 023 workflow controls without a new modality route or a permanent fourth layout column.

**Why this priority**: The collaboration UI must fit the established workspace rather than fragment it.

**Independent Test**: On image and video assets, an authorized user opens and closes Discussion, inspects activity/presence, follows a notification to a thread, and retains the current asset and Properties Panel context.

**Acceptance Scenarios**:

1. **Given** a selected workspace asset, **When** a user opens Discussion, **Then** it appears as an overlay or slide-in drawer and the existing Properties Panel remains available when the drawer closes.
2. **Given** an asset with activity, **When** a user switches from Discussion to Activity, **Then** human comments and machine/audit events remain distinct. Activity is a read-only projection of existing domain records and does not create a new source of truth or audit model.
3. **Given** a workspace notification deep link, **When** it references a comment, **Then** the target asset is selected and the corresponding thread is opened or highlighted.

---

### User Story 8 - Preserve Security and Operational Integrity (Priority: P2)

The platform keeps membership, assignments, comments, notifications, and audit records trustworthy under concurrent use, permission changes, reconnects, and operational failures.

**Why this priority**: Collaboration introduces shared state and must not weaken Phase 022/023 guarantees.

**Independent Test**: Automated tests attempt cross-dataset access, post-removal access, self/other comment modification, duplicate delivery, invalid assignment, and reconnect scenarios; no unauthorized or duplicate durable state appears.

**Acceptance Scenarios**:

1. **Given** concurrent valid collaboration commands, **When** they target the same logical item, **Then** resulting durable state is consistent and duplicate records are not created.
2. **Given** a member is removed or downgraded, **When** they hold an existing browser connection, **Then** later commands and protected reads are still rejected server-side.
3. **Given** a workflow event from Phase 023, **When** it produces a collaboration notification or activity entry, **Then** it does not alter the workflow transition, feedback, annotation revision, or Asset.status semantics.

---

### User Story 9 - Claim a Shareable Dataset Invitation (Priority: P1)

An Owner or eligible Manager can issue a single-use, expiring invitation link for a role they may grant. A person with an existing account can safely preview it, authenticate, explicitly join, and thereby become a normal `DatasetMember`.

**Why this priority**: It is a second, controlled membership-entry path for collaborators whose recipient is not known at creation time. It must converge on existing membership rather than create a parallel authorization system.

**Independent Test**: An Owner creates a Labeler link; a logged-out existing user previews it, signs in without changing membership, explicitly claims it, and subsequently accesses the dataset as a Labeler through normal authorization. A second claimant cannot use the consumed link.

**Acceptance Scenarios**:

1. **Given** an Owner or eligible Manager and a role they can grant, **When** they create a link, **Then** it is single-use, expiring, revocable while unused, immutable in role, and never grants Owner.
2. **Given** a recipient who opens a valid link, **When** they preview it before authentication, **Then** they see only the dataset display name, proposed role, inviter display name, and a safe availability state; opening or signing in neither consumes the link nor grants access.
3. **Given** an authenticated existing-account holder and a currently claimable link, **When** they explicitly choose Join dataset, **Then** one transaction rechecks current creator authority and claimability, creates exactly one normal `DatasetMember`, records safe durable audit/outbox intent, consumes the link, and presents an **Open workspace** CTA targeting `/workspace/{datasetId}`.
4. **Given** a previously removed or downgraded creator, expired/revoked/consumed link, deleted dataset, or existing claimant membership, **When** a claim is attempted, **Then** no membership or role mutation is created and the public result is safe and deterministic.
5. **Given** two users or two tabs claiming a link concurrently, **When** their requests race or a successful response is retried, **Then** at most one admission is caused by the link and a same-claimant retry converges without duplicate membership, notification, audit, or outbox state.
6. **Given** claim and revoke race for the same unused link, **When** one durable lifecycle transition commits first, **Then** that first transition wins: a committed revoke prevents admission, while a committed claim prevents later revocation and no contradictory state or partial membership exists.

### Edge Cases

- An invitee who is already an active dataset member MUST not receive a duplicate membership or duplicate invitation notification.
- A member cannot be assigned a responsibility incompatible with their current role. A role downgrade or removal that makes an active assignment incompatible MUST remove that active assignment in the same durable operation, preserve its history, and notify affected users; it MUST NOT silently reassign the work.
- An Owner cannot be removed or demoted through ordinary member-management actions; an Owner-only transfer process is outside this phase.
- Removing a member, deleting an asset, or deleting a dataset while comments, assignments, notifications, or presence exist MUST leave no newly accessible protected data. A retained historical notification for deleted context MUST have its context removed and display only a generic safe-unavailable outcome.
- A comment mention of a non-member, a removed member, or an inaccessible user MUST not disclose that user's membership or create a notification.
- Edits and deletes to a comment must preserve enough visible thread context to avoid making replies misleading; permanent hard deletion of discussion history is not implied by a user delete.
- Duplicate or reordered realtime delivery MUST NOT create duplicate durable comments, assignments, membership changes, or notifications.
- Retried notification production MUST use a stable recipient-and-event deduplication identity so one accepted domain action produces at most one notification for each intended recipient.
- A notification that points to deleted, removed, or no-longer-authorized context MUST show a safe unavailable outcome rather than leaking data.
- Presence data may be stale briefly and MUST NOT be used to grant permission, make workflow decisions, or lock annotations.
- This phase MUST NOT add realtime replication of annotation geometry, pointer positions, Canvas drafts, or other live annotation editing data.
- A shareable invitation link is not dataset access, a workspace credential, or realtime authentication. It becomes irrelevant after its explicit claim creates `DatasetMember`.
- A raw invitation-link secret MUST NOT appear in logs, audit/activity records, notifications, realtime envelopes, ordinary database display fields, or public errors.

## Requirements *(mandatory)*

### Functional Requirements

**Membership and authorization**

- **FR-001**: The system MUST provide an authorized member directory for each dataset showing active members and their collaboration role.
- **FR-002**: The system MUST use a durable pending-invitation lifecycle. An Owner or eligible Manager may create, revoke, or reissue an invitation; the target becomes an active DatasetMember only after accepting it. Every protected read and mutation MUST enforce authorization on the server.
- **FR-003**: The system MUST prevent ordinary member-management actions from removing or demoting the dataset Owner. Managers may manage Labeler and Reviewer membership but MUST NOT grant, remove, or change Manager or Owner roles; only the Owner may manage Manager membership.
- **FR-004**: A removal or role change MUST take effect for subsequent server-side authorization checks even if the affected user has an existing browser or realtime connection. It MUST revoke or re-authorize existing realtime subscriptions before they can receive later protected delivery.

**Assignments**

- **FR-005**: The system MUST support two distinct active asset responsibility types: annotation work for one eligible Labeler and review work for one eligible Reviewer; each asset may have one active assignee per type.
- **FR-006**: The system MUST let an authorized Owner or Manager create, reassign, and unassign each responsibility independently, recording who made the change and preserving enough history to identify the current active assignment. A role downgrade or removal that makes an assignment ineligible MUST remove it in the same durable operation, retain history, and notify affected users without an implicit reassignment.
- **FR-007**: Assignment actions MUST NOT directly change Asset.status, Asset revision, Annotation geometry, Annotation revision, or the Phase 023 workflow history.
- **FR-008**: The existing single `assignedToId` compatibility behavior MUST be audited before migration; any transition to typed assignments MUST preserve existing authorized assignment reads until consumers have moved to the new model.

**Discussion and mentions**

- **FR-009**: Authorized dataset members MUST be able to create asset-scoped root comments and direct replies in threads, view them in chronological context, and open the correct thread from a workspace deep link. A reply MUST target a root comment; reply depth MUST NOT exceed one.
- **FR-010**: The system MUST support references to active dataset members in comments and notify each valid mentioned recipient other than the actor at most once per comment.
- **FR-011**: A comment author MUST be able to edit or delete only their own comment. An Owner or Manager MAY moderate comments; the exact moderator visibility and deleted-comment presentation MUST be consistent across the thread.
- **FR-012**: Authorized thread participants and dataset moderators MUST be able to resolve and reopen a thread. Resolving a thread MUST NOT alter review feedback, workflow state, or annotation content.
- **FR-013**: Discussion comments and threads MUST remain distinct from Phase 023 rejection feedback and AssetWorkflowEvent history. A discussion entry MUST NOT be treated as a workflow transition or annotation edit history.

**Durable notifications**

- **FR-014**: The system MUST create a durable in-app notification for an accepted invitation, assignment/reassignment, valid mention, comment reply, and applicable Phase 023 submit/approve/reject event. It MUST not create a notification where the actor and recipient are the same user.
- **FR-015**: Notification production and retry handling MUST use a stable deduplication identity so a recipient receives at most one notification for one accepted domain event and notification retries never create duplicate durable notifications.
- **FR-016**: A recipient MUST be able to list notifications, distinguish unread items, mark an item read, and mark all notifications read without changing the underlying collaboration or workflow event. The Bell is placed immediately before the Account control in both global and workspace headers; its unread badge shows the count, displays `99+` above 99, and is hidden at zero.
- **FR-017**: Notifications MUST deep-link only to context the recipient is still authorized to view; their visible content and any public errors MUST not expose protected dataset, asset, comment, credential, URL, or annotation-geometry data.
**Realtime and presence boundaries**

- **FR-018**: Authoritative collaboration mutations and durable reads MUST use the product's established authenticated, authorized command and read boundary. Realtime delivery MUST NOT replace that boundary.
- **FR-019**: Realtime messages MUST be treated as delivery or invalidation signals. Browsers MUST refresh authoritative durable data before relying on a collaboration change after reconnect, missed delivery, or conflict.
- **FR-020**: Before implementation selects a realtime topology or finalizes collaboration data structures, the phase MUST audit existing runtime, deployment, network, Redis, authentication, Docker, and scaling constraints and document the justified decision.
- **FR-021**: Presence MUST show only lightweight, ephemeral dataset/asset viewing or editing activity to authorized dataset members and must expire when a client stops reporting activity. **PRESENCE IS NOT A LOCK.**
- **FR-022**: Presence MUST NOT authorize actions, reserve an asset, prevent a second user from editing, modify Asset.status, modify annotations, or be used as an optimistic-concurrency substitute.
- **FR-023**: The system MUST NOT deliver, persist, or synchronize live annotation geometry, Canvas pointer data, draft shapes, or annotation-editing state as part of this feature.

**Workspace integration, audit, and compatibility**

- **FR-024**: Workspace collaboration controls MUST integrate with the existing workspace header and selected-asset context. Discussion MUST use a drawer or overlay, not a permanent fourth column, and MUST NOT replace the Properties Panel.
- **FR-025**: The workspace MUST present a clear distinction between human discussion and machine/audit activity. Activity MUST be a read-only projection of existing domain records; it MUST NOT create a new source of truth, event store, or audit model. Existing Phase 023 workflow history remains its own authoritative audit surface.
- **FR-026**: Every accepted membership, assignment, comment, resolve/reopen, notification-read, and collaboration moderation action MUST have safe, attributable durable audit information; audit output MUST exclude comment bodies, review feedback, credentials, private URLs, and annotation geometry unless an authorized discussion read explicitly needs its own comment body.
- **FR-027**: All collaboration APIs and realtime subscriptions MUST enforce dataset scope and actor authorization independently of UI visibility. UI permissions are not a security boundary.
- **FR-028**: This phase MUST preserve the Phase 022 Asset Browser and the Phase 023 Start/Submit/Open Review/Approve/Reject/Rework workflow semantics. It adds participants and collaboration around them, not a new annotation workflow.
- **FR-029**: The system MUST provide a second, additive shareable invitation-link path alongside recipient-specific `DatasetInvitation`. Both paths MUST create the existing `DatasetMember` relationship; neither link possession nor authentication alone grants dataset access.
- **FR-030**: Only an Owner or eligible Manager MAY issue, list, or revoke a shareable invitation link, using the existing role-grant policy. A link MUST never grant Owner, and its role is immutable after issuance.
- **FR-031**: A shareable invitation link MUST be single-use, expiring, revocable while unused, and consumed only by an explicit authenticated claim from an existing account. Claim-time checks MUST revalidate dataset existence, creator authority to grant the encoded role, link lifecycle state, and claimant membership.
- **FR-032**: The durable representation MUST store only a non-reversible digest of a high-entropy raw link secret. Raw secrets MUST be returned only at issuance and carried only where necessary for preview/claim; they MUST be excluded from all logs, durable audit/activity, notifications, realtime, and error responses.
- **FR-033**: If a claimant is already a member, the system MUST return a deterministic `ALREADY_MEMBER` result, MUST NOT consume the link, create a duplicate member, or change the claimant role. Role changes remain member-management operations.
- **FR-034**: A successful link claim MUST create membership, membership/invitation audit evidence, required recipient-safe notification, and idempotent outbox intent in one `runCollaborationTransaction(...)`; job enqueue and Redis/WebSocket delivery occur only after commit.
- **FR-034a**: A successful link claim MUST create exactly one durable notification only for the link creator when claimant and creator differ. It MUST create no notification for the claimant, unrelated dataset members, or other managers/owners; issuance, revoke, unavailable claim, and `ALREADY_MEMBER` create none. The notification uses an additive `DATASET_MEMBER_JOINED` semantic type and a stable creator/link dedupe key that contains no raw token or digest.
- **FR-035**: Public preview MUST expose no more than dataset display name, proposed role, inviter display name, and `AVAILABLE` or generic `UNAVAILABLE` state. It MUST not disclose protected dataset content or differentiate terminal states in a way that forms a practical oracle.
- **FR-035a**: Authorized manager history is a separate projection from public preview. It MAY expose safe lifecycle/operational metadata needed to manage a link—link ID, role, status, creation/expiry/revocation/claim timestamps, and identities only to the extent already permitted by the member-management directory—but MUST never expose raw token, digest, reusable URL, protected dataset content, or internal authorization diagnostics.
- **FR-036**: Link preview and claim MUST use the established rate-limit/error-envelope conventions without making Redis a source of invitation or authorization truth. Rate-limit identity and thresholds require an explicit implementation approval gate.
- **FR-037**: Link claim concurrency and replay MUST have database-enforced or transaction-guarded single-use behavior: at most one claimant may be admitted by one link, same-claimant retry is idempotent, and revoked/expired/creator-authority races leave no partial durable state.
- **FR-038**: After a link claim, all dataset, workspace, assignment, notification, realtime-ticket, and presence authorization MUST use current `DatasetMember` authorization. Later removal must prevent an old link, old workspace URL, or old ticket from restoring access.
- **FR-038a**: A successful claim response and landing UI MUST present an **Open workspace** CTA to `/workspace/{datasetId}`. Following that route MUST perform normal current `DatasetMember` authorization; the invitation secret, fragment, URL, or prior successful claim MUST NOT be accepted as a workspace credential or propagated to the workspace URL.
- **FR-039**: Invitation-link operations MUST NOT mutate `Asset.status`, `Asset.revision`, `Annotation.revision`, annotation geometry, review feedback, `AssetWorkflowEvent`, assignment semantics, discussion semantics, or presence semantics.
- **FR-040**: Invitation-link activity, if displayed, MUST be a safe projection of existing invitation/membership events and MUST NOT create an Activity table or a reusable-token audit trail.

### Key Entities

- **Dataset Member**: An existing participant relationship between a user and a dataset. It remains the source of the user's dataset role and collaboration eligibility.
- **Typed Asset Assignment**: A durable, asset-scoped responsibility that identifies the current annotation or review assignee, the assigning actor, and its active/inactive lifecycle. It is separate from workflow state.
- **Dataset Invitation**: A durable pending/accepted/declined/revoked invitation for an existing user and proposed dataset role. It is not an active membership until accepted.
- **Shareable Invitation Link**: A separate durable, single-use invitation record with a token digest, proposed eligible role, creator, lifecycle state, and optional claimant evidence. It is not a DatasetMember and never authorizes a workspace request.
- **Asset Comment Thread**: A durable asset-scoped conversation consisting of one root comment and direct replies only, author, timestamps, deletion state, and resolution state. It is distinct from rejection feedback.
- **Comment Mention**: A durable association between a comment and a valid mentioned dataset member, used to avoid repeatedly deriving recipients from comment text.
- **Notification**: A durable recipient-specific record of a collaboration or workflow-related event, with read state and safe navigation context.
- **Presence Record**: A short-lived indication that an authorized user is viewing or editing a dataset or asset. It is not durable collaboration state and is not a lock.
- **Activity Projection**: A read-only view assembled from existing collaboration and workflow records. It creates no durable Activity record and is not a new audit authority.
- **Realtime Event**: A transient delivery signal for an authorized audience that identifies a collaboration change or presence update. It is not a replacement for authoritative reads or commands.
- **Phase 023 Workflow State and History**: Existing `Asset.status` and workflow audit concepts. They remain authoritative and unchanged by collaboration actions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized Owner can invite, locate, change an eligible member role, or remove a member in under two minutes, and a removed member's next protected dataset request is denied in 100% of tested cases.
- **SC-002**: An authorized Owner or Manager can assign, reassign, or unassign annotation and review responsibilities independently, with no observed change to the asset's annotation content or review workflow state in 100% of acceptance tests.
- **SC-003**: In a two-person threaded discussion, users can create a root comment, reply, mention an eligible member, resolve the thread, and reach the referenced asset/thread from its notification in under three minutes.
- **SC-004**: 100% of tested offline/reconnect notification scenarios preserve the recipient's durable notification history and unread/read state.
- **SC-005**: In two connected authorized sessions, comment, assignment, membership, and notification changes become visibly indicated to the relevant recipient within five seconds in 95% of test runs; an authoritative refresh produces the same durable result in 100% of runs.
- **SC-006**: Presence disappears from other viewers within the configured expiry window after a browser stops reporting activity, while both users remain independently able to perform every action their server-side permission allows.
- **SC-007**: 100% of tested cross-dataset, post-removal, invalid-role-assignment, other-user-comment-edit/delete, and unauthorized subscription attempts are rejected without disclosing protected collaboration data.
- **SC-008**: Existing Phase 022 assignment/browser tests and Phase 023 workflow, annotation revision, autosave, review-concurrency, and history tests continue to pass without semantic regression.
- **SC-009**: In 100% of real-PostgreSQL concurrent-claim tests, one link admits at most one claimant; retries by that claimant produce no duplicate `DatasetMember`, audit, notification, or outbox record.
- **SC-010**: In 100% of tested logged-out previews, no protected dataset, asset, annotation, workflow, assignment, discussion, membership, presence, storage, or credential detail is returned.
- **SC-011**: In 100% of create/list/history/preview/claim/realtime/activity/audit/notification retrieval tests after issuance, no raw invitation token or reusable share URL is retrievable. The one-time create response is the sole raw-secret disclosure.

## Assumptions

- Existing authenticated users are the only invite targets in this phase. Invitations use a pending lifecycle, may be accepted, declined, revoked, or expired, and do not grant dataset access before acceptance. Email delivery, account provisioning, and external guests are outside this first collaboration release.
- The dataset Owner is the only role that can manage Manager membership. Owners and Managers can manage Labeler/Reviewer members, assignments, and moderation as described above.
- Each asset has at most one active annotation assignee and one active review assignee. Reassignment replaces the active responsibility while retaining safe assignment history.
- A comment deletion is a soft, visible deletion that preserves thread continuity; comment editing/deletion retains authorship and audit-safe timestamps. Retention duration follows existing platform policy.
- Notifications are in-app only. Email, push, Slack, and other external delivery channels are out of scope.
- A workflow notification is created only after the Phase 023 transition has durably succeeded; collaboration does not retry, modify, or infer workflow transitions.
- Actors do not receive notifications for their own successful actions. Their own action remains visible through the relevant authoritative discussion, assignment, membership, workflow, or Activity projection.
- The global and workspace Bell is immediately before Account. Its accessible name includes the unread count when non-zero; its visible unread badge is hidden at zero and capped as `99+`.
- Activity is a UI projection of existing records, not a new activity table, event stream, source of truth, or audit model.
- The Phase 024 realtime topology is established: authenticated Next.js REST commands/reads, PostgreSQL durable authority, private-worker outbox relay, Redis delivery/ephemeral presence, a delivery-only `apps/realtime` gateway, fresh scoped tickets, revocation, and reconnect-to-authoritative-refresh. The share-link extension reuses this topology without changing it.
- Share links target only existing authenticated accounts in v1. There is no email delivery, account provisioning, guest identity, multi-use link, role editing, or owner transfer.
- The deterministic existing-member result is `ALREADY_MEMBER`; it leaves an unused link claimable by another eligible existing account. A claim replay after a successful same-user claim returns the original successful membership result without changing it.

## Out of Scope

- A new annotation workflow, workflow-status model, or change to the Phase 023 transition matrix.
- Any live replication of annotation geometry, pointer position, Canvas drafts, transforms, or annotation editing operations.
- Presence-based locks, reservations, or backend enforcement that prevents a second authorized user from viewing or editing solely because another user is present.
- A separate modality-specific workspace route, separate review application, permanent fourth workspace column, or replacement of the Properties Panel.
- Email, push, SMS, Slack, or other external notification channels.
- External/guest account invitations, account creation, owner transfer, organization/tenant management, workload balancing, or SLA scheduling.
- Bulk assignment/reassignment, bulk workflow decisions, real-time co-editing of annotations, or CRDT/operational-transform collaboration.
- Replacing, deleting, or repurposing `AssetWorkflowEvent`, rejection feedback, `Asset.status`, Annotation revisions, or existing workflow-history behavior.
- Link-based workspace authorization, invitation-token WebSocket authentication, invitation-token presence, multi-use links, guest/external invitations, email delivery, token rotation in place, or role changes through a link claim.
