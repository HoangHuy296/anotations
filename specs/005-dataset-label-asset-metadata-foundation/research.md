# Phase 005 Research

## Decision: authorization before resource lookup

**Decision**: Resolve actor and Dataset entitlement before returning Dataset, Label, or Asset metadata.

**Rationale**: A known identifier must not become an IDOR bypass.

**Alternatives considered**: Global `findUnique(id)` followed by UI filtering is rejected because it risks metadata disclosure.

## Decision: archive rather than hard delete

**Decision**: `DELETE /api/datasets/[datasetId]` sets archive state only.

**Rationale**: It preserves references and matches the ownership policy.

## Decision: cursor-safe bounded asset metadata

**Decision**: Use bounded pagination and safe metadata filters scoped to one Dataset.

**Rationale**: It avoids unbounded queries and prevents binary/provider details entering the response.
