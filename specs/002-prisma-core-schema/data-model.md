# Approved Core Model Constraints

| Area | Schema constraint |
| --- | --- |
| Identity | `User.email` and `AuthSession.refreshTokenHash` are unique; sessions cascade with user deletion. |
| Dataset | central entity; `primaryModality` is nullable; membership is unique per dataset/user. |
| Asset | required `modality` and `sourceFingerprint`; unique `[datasetId, sourceFingerprint]`; one optional detail relation per modality. |
| Labels | dataset-scoped unique normalized name; nullable modality supports cross-modal labels. |
| Annotation | `geometry` is canonical `Json`; `version` starts at 1; application must perform versioned writes. |
| Provenance | repository unique by provider/base URL/full name and has no token fields; source connection owns encrypted tokens. |
| Jobs | one common `Job`, idempotency unique per dataset, queue linkage indexed; `JobEvent` belongs to Job. |

Supporting `AssetVersion`, `VideoObjectTrack`, `AudioSpeaker`, and `AiTask` preserve provenance and modality detail; they do not replace the required core entities.
