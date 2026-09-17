# Feature Specification: TEXT Workspace Engine

**Feature Branch**: No feature branch created; specification prepared on `main`.

**Feature Directory**: `specs/025-text-workspace-engine`

**Created**: 2026-09-15

**Status**: Draft — ready for planning; implementation remains subject to the gates below.

**Input**: User request to prepare Phase 025 from the supplied TEXT Workspace Engine brief: make manual text annotation the third complete workspace engine after IMAGE and VIDEO, reusing the existing platform and preserving its authorization, revision, workflow, and collaboration semantics.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read and navigate the original document (Priority: P1)

An authorized dataset member opens a TEXT asset through the existing Asset Browser and reads, selects, scrolls, and searches its original document in the shared workspace. The same surrounding navigation, header, toolbox, and properties area remain available.

**Why this priority**: Correct source text and stable selection are prerequisites for every meaningful text annotation.

**Independent Test**: Open existing plain-text assets containing multilingual text, navigate between assets, search repeated phrases, and change the display width. Verify the document against its source without creating an annotation.

**Acceptance Scenarios**:

1. **Given** an accessible TEXT asset with a supported source, **When** a member opens it, **Then** the existing workspace displays the original text, source readiness, available details, and TEXT capabilities rather than an image tool or a placeholder.
2. **Given** a loaded document, **When** the member selects text, scrolls, changes font size or window width, or searches for a phrase, **Then** the source stays unchanged and matches remain distinct from annotation highlights.
3. **Given** a missing, malformed, unsupported, or oversized source, **When** the document opens, **Then** a safe unavailable/unsupported state explains what can be retried; the workspace does not display partial content as a complete annotatable document.
4. **Given** missing language or segmentation metadata, **When** details are displayed, **Then** the missing value is shown as unavailable rather than guessed or replaced with an example value.
5. **Given** a removed member or an asset outside the member's dataset, **When** source or annotation data is requested, **Then** access is denied with the established concealed-resource behavior and no source excerpt or protected metadata is disclosed.

### User Story 2 - Create and refine spans and entity labels (Priority: P1)

An authorized annotator selects an exact range, saves a span, optionally assigns an eligible dataset label, and later expands, shrinks, relabels, or deletes that span. Nested and overlapping entities remain individually selectable.

**Why this priority**: Character spans are the minimum useful text annotation and the basis of entity labeling.

**Independent Test**: On an editable TEXT asset, create unlabeled and labeled spans, adjust their boundaries, reload, and compare highlighted text and metadata against the original source.

**Acceptance Scenarios**:

1. **Given** an editable document and a nonempty valid selection, **When** the annotator creates a span, **Then** its exact half-open source range is saved and remains associated with that source after reload.
2. **Given** `OpenAI builds AI.`, **When** the annotator labels `OpenAI`, **Then** the span has start 0 and end 6, and its label comes from the dataset taxonomy.
3. **Given** a span with a label and custom properties, **When** either boundary is changed, **Then** only its range and required revision/audit information change; label, class, color, confidence, status, relation identity, and unrelated properties remain unchanged.
4. **Given** a span, **When** its label or supported custom properties change, **Then** its range and referenced source remain unchanged.
5. **Given** overlapping ranges such as `New York` and `New York University`, or a nested name inside a larger phrase, **When** the annotator inspects either annotation, **Then** both retain separate identities and each exact range can be selected and edited.
6. **Given** empty, reversed, out-of-bounds, fractional, or invalid Unicode boundaries, **When** a create or update is attempted, **Then** it is rejected without any partial annotation or parent-review revision change.
7. **Given** emoji, combining marks, accented text, or CJK, **When** a span is saved, reloaded, or exported, **Then** it identifies the same original source range; display changes never shift it.

### User Story 3 - Classify a document using its taxonomy (Priority: P2)

An annotator assigns document-level categories, including configured sentiment labels, without selecting a fabricated span covering the whole document.

**Why this priority**: Document classification supports distinct NLP tasks while sharing the same source, taxonomy, and review lifecycle.

**Independent Test**: Use datasets configured for single-label and multi-label classification. Create, replace, remove, and reload classifications without creating spans.

**Acceptance Scenarios**:

1. **Given** eligible document labels, **When** an annotator classifies a document, **Then** the annotation has explicit document scope and no artificial character range.
2. **Given** single-label policy, **When** a category is replaced, **Then** the replacement is atomic and leaves at most one category in that classification group; a stale replacement cannot remove a newer category.
3. **Given** explicitly enabled multi-label policy, **When** several distinct categories are chosen, **Then** they coexist only within that policy, remain individually removable, and survive reload.
4. **Given** no sentiment taxonomy, **When** the toolbox is displayed, **Then** it does not invent sentiment classes. With a configured sentiment taxonomy, sentiment follows classification behavior rather than a separate state machine.
5. **Given** document classifications and spans, **When** either kind is edited or removed, **Then** the other kind is not implicitly changed.

### User Story 4 - Describe relations between annotated entities (Priority: P2)

An annotator selects two compatible spans in the same document, chooses a configured relation type, and inspects or edits that relationship independently of the span geometry.

**Why this priority**: Relations turn isolated entity labels into structured language datasets and are required for the complete Phase 025 delivery.

**Independent Test**: With two preexisting spans and an eligible relation taxonomy, create, retarget, relabel, and delete a relation; exercise endpoint deletion and concurrent modification.

**Acceptance Scenarios**:

1. **Given** two compatible spans in one document, **When** a relation is created, **Then** it references their identities and a configured relation type, without copying their ranges or selected text.
2. **Given** a relation, **When** its type, endpoint, or supported metadata changes, **Then** the spans' ranges, labels, and metadata remain unchanged.
3. **Given** a related span, **When** its boundaries change, **Then** the relation retains its annotation reference and displays the updated source range. A label change that would violate configured endpoint compatibility is rejected without partial writes.
4. **Given** a self-relation, duplicate directed pair/type, missing endpoint, incompatible endpoint, or endpoint from another asset or dataset, **When** a relation is submitted, **Then** it is rejected with no dangling relationship.
5. **Given** a span with attached relations, **When** it is deleted, **Then** deletion is refused until the relations are explicitly removed. Concurrent relation creation and span deletion cannot both succeed in a way that leaves a dangling reference.
6. **Given** no eligible relation taxonomy, **When** the toolbox opens, **Then** relation creation is unavailable with an understandable reason rather than offering hardcoded relation types.

### User Story 5 - Save safely and complete review or rework (Priority: P1)

An annotator saves text work and submits it through the existing asset workflow. A reviewer inspects the complete document and annotations, approves or rejects the asset, and can inspect rejection/rework history without a TEXT-specific workflow.

**Why this priority**: Annotation correctness includes preventing lost edits and ensuring reviewers decide on the current saved work.

**Independent Test**: Seed a TEXT asset with annotations and two authorized actors. Exercise Start, Submit, Open Review, Approve, Reject, Start Rework, and Resubmit, including a save conflict and a stale review decision.

**Acceptance Scenarios**:

1. **Given** pending span, classification, relation, or supported-property edits, **When** Submit or Resubmit is requested, **Then** all required saves finish successfully before the transition uses the resulting current asset revision.
2. **Given** a failed or conflicting save, **When** Submit or navigation away is requested, **Then** the workspace blocks silent continuation, explains the unsaved work, and provides retry, reload/reconcile, or explicit discard where appropriate.
3. **Given** two editors starting from the same annotation revision, **When** incompatible updates or deletes race, **Then** at most one succeeds; the other receives a conflict and cannot overwrite the winner through autosave or Undo.
4. **Given** a reviewer holding an earlier asset revision, **When** an annotation change has committed and the reviewer decides, **Then** the stale decision is refused through the existing review-staleness boundary.
5. **Given** an asset in NEEDS_REVIEW, REVIEWED, or REJECTED, **When** a prohibited annotation mutation is attempted through either controls or a direct request, **Then** it is refused while scrolling, searching, selection for inspection, and authorized Discussion remain usable.
6. **Given** a rejected asset, **When** an authorized actor starts rework, edits, and resubmits, **Then** editing and review follow the established lifecycle and Workflow History retains the rejection feedback and transitions.
7. **Given** an ordinary annotation edit, **When** it is undone or redone, **Then** current authorization and revisions are checked; workflow, assignments, other users' committed edits, and Discussion are never undone.

### User Story 6 - Collaborate in the existing workspace (Priority: P2)

Owners/managers assign existing annotation and review Responsibilities for TEXT assets. Members use Discussion, Activity, notifications, and presence without a second collaboration system or a fourth permanent column.

**Why this priority**: TEXT must participate in the established team process rather than isolate language work from the platform.

**Independent Test**: Assign an annotator and reviewer to a TEXT asset, open two sessions, add Discussion, change workflow, and verify Activity, Bell, revocation, and presence using existing collaboration fixtures.

**Acceptance Scenarios**:

1. **Given** an owner, eligible annotator, and eligible reviewer, **When** Responsibilities are assigned, **Then** the existing role/assignment policies and notifications apply exactly as for other assets.
2. **Given** a TEXT workspace, **When** Discussion or Activity is opened, **Then** it uses the existing asset conversation and read-only activity projection; annotation custom properties are not used as Discussion storage.
3. **Given** another authorized member commits a change, **When** an invalidation arrives or the client reconnects, **Then** authorized reads converge on durable state without silently replacing unsaved local drafts.
4. **Given** a member editing text annotations, **When** presence updates, **Then** only existing VIEWING/EDITING awareness and authorized identity/scope data are conveyed; source text, selected text, offsets, draft content, endpoints, cursors, and search queries are absent.
5. **Given** membership removal or a role downgrade, **When** the affected member next reads, writes, or renews realtime access, **Then** current platform authorization is applied; stale UI state and presence do not grant access or a lock.

### User Story 7 - Inspect efficiently with keyboard and structural views (Priority: P3)

An annotator uses the keyboard, offset inspector, annotation list, search, and available deterministic document views to work accurately on longer multilingual documents.

**Why this priority**: Accessibility and predictable performance are part of a complete engine, while optional linguistic views must not invent annotation authority.

**Independent Test**: Complete span, classification, and relation operations using keyboard controls on the reference document set; compare source ranges before and after display and structural-view changes.

**Acceptance Scenarios**:

1. **Given** keyboard-only operation, **When** a member selects source text, chooses a label, adjusts boundaries, searches, or inspects relations, **Then** focus and action names are available and existing Submit/Approve shortcuts are not accidentally triggered by typing or text interactions.
2. **Given** authoritative segmentation metadata, **When** token, sentence, or paragraph views are selected, **Then** their displayed indexes/counts are consistent across sessions and independent of visual wrapping.
3. **Given** no authoritative tokenizer or segmentation result, **When** the toolbox and inspector render, **Then** unavailable durable indexes are not offered; any explicitly identified view-only tokenization cannot be saved as geometry.
4. **Given** nested or same-range annotations, **When** color alone is insufficient to identify one, **Then** the annotation list, text labels, and focus affordances permit an unambiguous selection.

### Edge Cases

- Empty existing documents remain readable but cannot have spans; eligible document classifications can still be represented. Whitespace-only nonempty selections are valid and preserved without trimming; creating new empty-source imports is not added to this phase.
- Leading/trailing whitespace, tabs, newlines, byte-order marks, and composed/decomposed text must follow the single documented source/offset contract without silent trimming or normalization.
- The Unicode fixture set includes ASCII, `A😀B`, combining marks, precomposed accented text, multi-code-point emoji, CJK, mixed scripts, bidirectional text, and repeated substrings. Equal visible text at different positions is not interchangeable.
- Backward selections and selections crossing rendered chunks must resolve to one valid forward source range. Disjoint selections are not combined into a discontinuous annotation in this phase.
- Nested/partially overlapping spans and same-range spans with different labels remain addressable. Replaying the same create operation must not create a duplicate.
- Source replacement or mismatch after an annotation was created makes editing unavailable until reconciled; the client must not silently reuse offsets against different text.
- Relation endpoint deletion, relabeling, or concurrent modification must preserve compatibility and referential integrity even when requests race.
- Taxonomy removal or policy changes cannot silently relabel annotations, drop extra classes, or retarget relations. Preserve existing readable work and expose invalid configuration until an authorized reconciliation.
- Unavailable source/storage, failed processing, revoked membership, stale revisions, disconnected clients, and out-of-order save responses must not result in false “saved” state.
- Markup-looking source is displayed as source text, not executed. Source excerpts and search queries do not become URL parameters, telemetry, or realtime payloads.
- Navigation to a non-TEXT asset resets TEXT-only transient selection/history appropriately and preserves that asset's existing engine behavior.

## Requirements *(mandatory)*

### Functional Requirements

#### Workspace, source, and capabilities

- **FR-001**: TEXT MUST open in the existing workspace selected by the asset's recorded modality, reusing Asset Browser, navigation, header, toolbox, properties region, and dataset context. It MUST NOT introduce a separate shell or permanent fourth column.
- **FR-002**: The engine MUST read one authoritative, immutable original text representation per source identity. Annotation operations MUST NOT edit, replace, trim, normalize, or re-encode the original text as a side effect.
- **FR-003**: Source readiness MUST distinguish readable, pending, unavailable, invalid, and unsupported states where applicable; incomplete or stale source content MUST NOT be presented as ready for durable range creation.
- **FR-004**: The source contract MUST define supported encoding, source identity, newline/byte-order-mark treatment, and documented size limits. Ambiguous legacy content MUST be reconciled explicitly rather than selecting arbitrarily between conflicting copies.
- **FR-005**: Members MUST be able to scroll, select, search, move between matches, and focus an annotation without changing durable source or annotation state. Search highlights MUST be distinguishable from saved spans.
- **FR-006**: Toolbox items MUST depend on implemented engine capabilities, eligible taxonomy, current permissions, source readiness, and workflow state. Unsupported tools MUST be omitted or disabled with a reason; image bounding boxes MUST NOT appear as text annotation tools.
- **FR-007**: Text Details MUST expose filename, supported encoding, source character count in the declared unit, known language, and processing state. Token/sentence/paragraph counts MUST be shown only when their derivation is authoritative and reproducible.
- **FR-008**: The existing properties region MUST provide text details, eligible labels, spans/classifications/relations, selected-annotation inspection, Description, Responsibilities, and Workflow History, while retaining existing navigation and collaboration entry points.

#### Text geometry and taxonomy

- **FR-009**: Durable span geometry MUST use a single declared character-offset unit and half-open ranges `[startOffset, endOffset)`, with integer boundaries satisfying `0 <= startOffset < endOffset <= sourceTextLength` in that same unit.
- **FR-010**: Saving, reading, importing/exporting where supported, processing, and reloading a range MUST identify the same original source substring for every supported Unicode fixture. Display wrapping, font size, zoom, scroll, or rendering chunks MUST NOT affect its meaning.
- **FR-011**: Selection and boundary editing MUST reject invalid boundaries under the approved Unicode contract and MUST NOT split a user-perceived character unintentionally. The inspector MUST make the offset unit visible; byte positions and display columns MUST NOT masquerade as character offsets.
- **FR-012**: An authorized annotator MUST be able to create, inspect, expand, shrink, relabel, and delete a contiguous span. Unlabeled highlights are permitted; entity annotations use an eligible dataset label.
- **FR-013**: Geometry edits MUST preserve all unrelated annotation metadata and relation identities. Label/property edits MUST preserve geometry. Selected source text MUST be resolved from the authoritative source range, not treated as a second editable source.
- **FR-014**: Overlapping and nested spans MUST be supported. Exact same-range/same-label duplicates are rejected or reconciled as a replay; different labels on the same range remain distinct. Empty ranges are invalid; nonempty whitespace ranges are preserved exactly.
- **FR-015**: Entity, classification, sentiment, and relation choices MUST come from compatible dataset taxonomy/configuration. No built-in example class, language, relation, model, user, or dataset identity may become an implicit business rule.
- **FR-016**: Annotation custom properties MUST follow supported validation and permission rules and MUST remain separate from source geometry and asset Discussion.

#### Classification and relations

- **FR-017**: Document classification MUST have explicit document scope and MUST NOT require a synthetic full-document span. Creation, replacement, deletion, and inspection MUST work independently of span labeling.
- **FR-018**: Classification cardinality MUST follow dataset capability/configuration. Without an explicit multi-label policy, the default is one label per configured classification group; without configured groups, one classification label per document. Replacing a label MUST be atomic and revision checked.
- **FR-019**: Multi-label classification MUST require explicit enablement, reject duplicate category membership, and permit independent removal. Changing policy MUST NOT silently discard existing annotations.
- **FR-020**: Sentiment MUST be a configured classification use case, with no hardcoded sentiment categories and no independent workflow or annotation authority.
- **FR-021**: Relations MUST have their own identity, directed source/target annotation references, an eligible relation type, supported metadata, and revision-checked create/update/delete behavior. They MUST NOT copy endpoint geometry.
- **FR-022**: First-delivery relation endpoints MUST be compatible spans on the same TEXT asset and source identity. Self-relations, duplicate source/target/type triples, cross-asset/dataset relations, relations to relations, and document-classification endpoints MUST be rejected.
- **FR-023**: Endpoint boundary changes MUST retain relation identity; incompatible endpoint relabeling MUST be rejected. Deletion of a referenced span MUST be blocked until attached relations are explicitly removed. Concurrent operations MUST never leave dangling or cross-scope references.
- **FR-024**: Relation creation, retargeting, type changes, and deletion MUST NOT alter source/target spans or unrelated classifications. The inspector MUST allow navigation to both endpoints without depending on a drawn connector.

#### Persistence, review, and collaboration

- **FR-025**: Every supported durable update/delete MUST require the existing optimistic revision check. A successful content mutation MUST invalidate the parent asset's review revision atomically; a failed mutation MUST leave both annotation content and the parent revision unchanged.
- **FR-026**: Retried creates MUST be idempotent. Concurrent incompatible edits, duplicate relation creation, single-label replacement, and endpoint deletion MUST produce a valid complete outcome or a conflict, never a partial result.
- **FR-027**: Autosave MUST persist only deliberate annotation edits at semantic action boundaries, report pending/saving/saved/failed/conflict honestly, and prevent stale responses from replacing newer content. Selection, hovering, scrolling, searching, temporary highlights, and relation-builder previews MUST remain ephemeral.
- **FR-028**: Submit/Resubmit MUST wait for successful saves for the selected asset and use its resulting current review revision. Failure or conflict MUST prevent workflow submission. Navigation MUST not silently discard unsaved work.
- **FR-029**: TEXT MUST reuse the established asset lifecycle: Start to IN_PROGRESS; Submit/Resubmit to NEEDS_REVIEW; Open Review without a new workflow state; Approve to REVIEWED; Reject to REJECTED; Start Rework to IN_PROGRESS. Existing history, feedback, permission, and stale-decision semantics MUST remain unchanged.
- **FR-030**: Prohibited content mutations MUST be rejected in NEEDS_REVIEW, REVIEWED, and REJECTED through authoritative validation, including direct requests and Undo/Redo. Read-only review MUST still permit scrolling, searching, annotation inspection, and authorized Discussion.
- **FR-031**: Standalone Accept Annotation, Reject Annotation, and Mark Annotation Reviewed controls MUST NOT alias asset approval/rejection. They are deferred in the initial delivery unless a separately explicit annotation-level policy is designed; existing status fields alone do not establish that policy.
- **FR-032**: Undo/Redo MUST cover supported local span, label, property, classification, and relation edit operations under current revisions/permissions. It MUST NOT undo workflow, membership, assignments, Discussion, notifications, or another user's committed changes. A conflicting inverse operation MUST leave current durable content intact.
- **FR-033**: All source reads, annotation operations, exports, and collaboration entry points MUST use existing dataset membership and permission policies, including own/any annotation distinctions and system-administrator behavior. Assignment or presence MUST NOT independently grant permission.
- **FR-034**: TEXT MUST reuse typed annotation/review Responsibilities, asset Discussion, read-only Activity, Workflow History, durable notifications, and authorized invalidation. It MUST NOT create TEXT-specific versions of these systems.
- **FR-035**: Realtime messages MUST remain invalidations and permitted awareness only. Source text, selected text, offsets, draft annotations, relation endpoints, cursors, and search queries MUST NOT be transmitted through realtime or Presence. Presence MUST remain VIEWING/EDITING awareness, never an edit lock.
- **FR-036**: Authorized reload after invalidation/reconnect MUST converge on current saved content while preserving or explicitly resolving unsaved local work. Removed members MUST be denied further protected access through the existing revocation mechanism.

#### Structure, accessibility, safety, and compatibility

- **FR-037**: Character spans MUST work without a tokenizer or AI provider. Durable token indexes MUST be unavailable unless deterministic tokenization and tokenizer/version identity are defined; otherwise token view is deferred or explicitly view-only.
- **FR-038**: Sentence and paragraph indexes/counts MUST derive from reproducible source segmentation, not visual wrapping. Missing segmentation MUST not block character annotation. Display transformations MUST never change saved offsets.
- **FR-039**: Core source navigation, selection, span editing, classification, relation editing, and inspection MUST be keyboard accessible, expose visible focus and accessible names, and communicate errors without relying solely on color. Typing and active text interactions MUST not trigger workflow shortcuts.
- **FR-040**: The workspace MUST meet the reference document responsiveness targets in Success Criteria without duplicating the original document per annotation. Unsupported document sizes MUST be rejected clearly rather than silently truncated or allowed to freeze the workspace.
- **FR-041**: Source text MUST be rendered as data, never executable markup. Reads and errors MUST not disclose provider credentials, private object locators, server configuration, unauthorized excerpts, or raw upstream diagnostics. Search/source content MUST not be placed in logs or durable browser storage.
- **FR-042**: Source references, deployment endpoints, policy limits, and taxonomy identities MUST come from validated configuration or authorized durable records; TEXT MUST introduce no machine-specific addresses or sample identity/class constants into business behavior.
- **FR-043**: Existing full-dataset and selected-asset annotation exports MUST preserve supported TEXT scope, ranges, offset-unit/source identity information, classifications, and relation references without exposing storage credentials. Exported relations MUST resolve within the exported annotation set. Existing IMAGE/VIDEO export contracts MUST remain compatible.
- **FR-044**: Future AI proposals MUST be able to normalize into the same text domain and follow proposal acceptance policy; manual delivery MUST NOT require AI integration, add an AI provider, or persist provider-specific structures as canonical text annotations.
- **FR-045**: Existing IMAGE, VIDEO, Asset Browser, workflow/revision, collaboration, notification, and realtime behavior MUST remain intact. Shared changes MUST address identified TEXT blockers through existing engine/capability boundaries rather than an unrelated repository-wide refactor.
- **FR-046**: The documented text read/write contract MUST cover source readiness, annotations, conflicts, authorization, and validation failures. Feature completion MUST include updated public contract documentation and real concurrency, browser, production deployment, and regression evidence; skipped tests MUST be reported as unverified.

### Key Entities *(include if feature involves data)*

- **TEXT Asset / Source Document**: An existing dataset asset and its one original source identity, declared encoding, text length in a known unit, readiness, and available language/structure metadata. Source content is immutable for this feature.
- **Text Span Annotation**: An existing-platform annotation identity with contiguous text geometry, source association, optional eligible label, supported properties, authorship, and optimistic revision.
- **Document Classification**: An annotation with explicit document scope, eligible category/group, cardinality policy, and revision. Sentiment uses this same concept.
- **Text Relation**: A revisioned annotation relationship between two eligible span identities with a directed configured type and metadata, subject to same-document integrity.
- **Dataset Taxonomy and Text Capabilities**: Existing dataset labels plus explicit eligibility, classification cardinality/grouping, and relation compatibility policies. They determine available tools without embedding example categories.
- **Derived Text Structure**: Optional reproducible token, sentence, or paragraph indexes linked to the source and derivation identity; never a competing source or layout-derived geometry authority.
- **Asset Review State and Content Revision**: Existing asset workflow state, review-staleness revision, history, and rejection feedback. TEXT adds no alternate state machine.
- **Shared Collaboration Context**: Existing dataset membership, Responsibilities, Discussion, Activity, notifications, invalidation, and ephemeral presence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the complete acceptance journey, an owner assigns an annotator/reviewer; the annotator creates and edits spans, a classification, and a relation; saved work reloads correctly; the reviewer can approve or reject; and rework/resubmission preserves history. Every step completes within the existing workspace without manual data repair.
- **SC-002**: 100% of the approved Unicode/source fixtures select exactly the same original substring after save, reload, supported export, layout change, and source processing. Invalid range fixtures cause no durable change.
- **SC-003**: 100% of the metadata-isolation scenarios preserve unrelated fields: geometry edits do not relabel, label edits do not move spans, and relation edits do not change endpoints' content.
- **SC-004**: All controlled conflicting-edit, stale-review, replay, relation-integrity, rollback, and single-label replacement scenarios produce either one valid committed outcome or an explicit conflict; none produces a lost committed edit, duplicate retry output, dangling relation, or partial parent revision change.
- **SC-005**: On the reference acceptance environment, a document of up to 100,000 declared character units with 1,000 spans and 100 relations is readable and navigable within three seconds of opening in at least 95 of 100 trials. Local selection/focus/search-next feedback completes within 200 milliseconds in at least 95 of 100 interactions after loading. Planning records the hardware/network and reproducible dataset used for measurement.
- **SC-006**: A keyboard-only evaluator can complete reading/search, span CRUD, classification CRUD, relation CRUD, and review inspection without a pointer or accidental workflow action. Each overlapping annotation remains individually discoverable without relying only on color.
- **SC-007**: Every unauthorized, removed-member, cross-dataset, and review-frozen mutation case is denied, and no tested presence/invalidation payload contains source text, ranges, selected text, or drafts.
- **SC-008**: Every supported TEXT edit survives successful autosave and reload; every simulated failed/conflicting save prevents false saved status and silent Submit/navigation data loss.
- **SC-009**: All existing IMAGE/VIDEO and Phase 022/023/024 acceptance journeys selected for the affected shared surfaces still pass. Completion evidence distinguishes executed passing checks, failures, and unexecuted/skipped runtime checks.

## Assumptions

### Scope and product defaults

- This command prepares the specification only. The supplied full delivery brief defines the eventual phase, not authorization to skip research, model design, planning, contracts, tasks, implementation, or proof stages.
- Existing imported/uploaded plain-text TEXT assets are the first source population. CSV/JSON already recognized as text are displayed as their original document text; structured record editing, rich text, OCR/PDF extraction, source editing, and new import-format support are out of scope.
- Empty-source import support is not added. Existing readable empty documents can have explicit document scope but no spans.
- The product defaults in FR-014, FR-018, and FR-022–FR-023 are intentional: overlaps allowed, single-label unless configured otherwise, directed same-document span relations, no self/duplicate relations, and explicit relation removal before endpoint deletion. They do not introduce new role policies.
- Discontinuous spans, cross-document relations, token/POS annotation, new linguistic models, and AI/NLP providers are deferred. Structural views are conditional on reproducible derivation, not mandatory new processing pipelines.
- Annotation-level acceptance/rejection is deferred; asset-level review is required. Comment/Note uses existing Discussion or already supported annotation custom properties according to their distinct meanings, not a new note system.
- The performance corpus is a minimum verification target, not permission to silently lower existing upload limits. Supported whole-document limits and larger-document behavior must be documented during planning.

### Dependencies and mandatory planning gates

- The existing shared platform, storage, authorization, workflow, annotation revisions, and collaboration remain prerequisites. Previous review findings and dirty working-tree changes must be rechecked in affected paths; a past report is not current runtime proof.
- **G1 — Unicode contract**: Before any durable span work, `research.md` and `data-model.md` must select one offset unit, distinguish stored encoding from position semantics, define valid boundaries and normalization/newline/BOM policy, and give exact numeric expectations for `A😀B`, combining marks, and the wider fixture set across every producer/consumer. The spec deliberately does not choose a language-specific representation.
- **G2 — Source authority**: Audit actual stored assets as well as code. Decide how optional legacy content and current source objects reconcile to one immutable source identity, how source is read securely, supported encodings/limits, and mismatch handling. Missing authority blocks editing, not permission to create a mock source.
- **G3 — Annotation representation**: Compare extending generic annotations, associated text-specific structures, and another minimal additive design against existing geometry/revision/label/relationship support. Document one authority for geometry and any compatibility projections. Do not infer from existing columns that their semantics are already proven.
- **G4 — Relation integrity and classification policy**: Document enforceable same-source endpoint compatibility, uniqueness, blocked endpoint deletion, concurrency/rollback behavior, explicit document scope, and configurable classification cardinality. Taxonomy deletion/reconfiguration must preserve valid references or fail safely.
- **G5 — Deterministic structure**: Audit whether any tokenizer/segmenter is actually authoritative. Without such a pipeline, defer durable token indexes; any proposed processing must reuse the established asynchronous job boundary and record derivation identity.
- No migration or durable text implementation starts until G1–G5 are recorded and resolved. Additive migration is the default; destructive changes require separate approval. Changes to established platform boundaries require an explicit decision before proceeding.
- Later documents follow the requested sequence: repository findings in research, model contract, implementation plan, contracts/public API documentation, dependency-ordered tasks, then implementation slices and proof. The planning workflow must preserve these dependency gates even if its template emits several documents together.
- Final proof requires real PostgreSQL concurrency tests, authorized request tests, production-style multi-user browser acceptance, schema/migration checks, public contract validation, builds, normal/review deployment validation, and IMAGE/VIDEO plus workflow/collaboration regressions. Specification validation is not a substitute for that proof.
