# Dataset Metadata Data Model

| Entity | Existing fields | Rules in this phase |
| --- | --- | --- |
| Dataset | ownerId, type, primaryModality, metadata, archivedAt | Owner derives from session. `MULTI_MODAL` is allowed; primary modality is optional. Delete archives only. |
| Label | datasetId, name, normalizedName | Normalize consistently; unique by existing `(datasetId, normalizedName)` constraint. |
| Asset | datasetId, modality, filename, mimeType, sizeBytes, status | List only safe metadata in authorized Dataset; never expose binary/storage/provider secrets. |

## Integrity

- Label route scope and `Label.datasetId` must match.
- Asset filters and pagination never escape authorized `Dataset.id`.
- Client input cannot set Dataset owner or reassign an existing record across datasets.
