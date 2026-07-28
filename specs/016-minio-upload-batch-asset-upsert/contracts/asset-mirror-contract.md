# Asset Mirror and Reconciliation Contract

## Deterministic identity

`sourceFingerprint = SHA-256(datasetId, provider, owner, repo,
resolvedRevision, normalizedPath, providerFileIdentity)`.

The object key is server-generated from Dataset ID and fingerprint. It is
private and never browser-visible as metadata or a response field.

## Durable publish sequence

1. Validate candidate path, supported modality, and server-controlled file
   limits.
2. Stream to the deterministic MinIO object key; verify the stored object.
3. In a Prisma transaction, reconcile `Asset` by `[datasetId,
   sourceFingerprint]`, then upsert exactly its matching modality child row.
4. On Prisma failure, remove only the deterministic key if no Asset references
   the exact bucket/key. Never delete an object outside this import scope.

## Retry/reconciliation rules

- Existing matching Asset/object is reused; no duplicate Asset, child row, or
  object is created.
- Changed immutable revision/provider identity yields a new fingerprint.
- A failed file increments only a safe aggregate count; processing continues
  with other files unless the error is fatal.
