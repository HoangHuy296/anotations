# T007 (E2) — result-to-input correlation evidence

Date: 2026-09-24. Inputs: three same-basename objects (`…/a/img.jpg`, `…/b/img.jpg`, `…/c/img.jpg`) with distinguishable content (810×1080 bus photo, 1280×720 photo, 640×480 flat gray). Correlation key tested: exact echo of the submitted signed URL in each output's `image_path`, compared through SHA-256 (the same digest the adapter stores).

## Observed (one accepted task, N=3, run A; repeated identically in run B)

| Submitted index | Returned position | `image_path` exact echo of submitted URL | width×height | detections |
| --- | --- | --- | --- | --- |
| 0 (bus) | 0 | yes | 810×1080 (matches file) | 5 |
| 1 (photo) | 1 | yes | 1280×720 (matches file) | 3 |
| 2 (flat gray) | 2 | yes | 640×480 (matches file) | **0** |

Output item keys: `width`, `height`, `outputs[]` (each `box [xmin,ymin,xmax,ymax]` in image pixels, `score`, `class_id`, `class_name`), `image_path`, `class_names` (80 entries). No stable per-input identifier other than `image_path`.

## Requirement matrix

| Requirement | Result | Evidence / reason |
| --- | --- | --- |
| Deterministic input→result correlation by exact URL echo | **PASS (observed)** | 3/3 exact matches; image dimensions independently confirm each mapping; same-basename inputs resolved by full URL; identical result set on the identical retry (run B). |
| Correlation is a contractual guarantee | **UNPROVEN** | The deployed OpenAPI types `output` as free-form objects; `image_path` echo is observed, not specified. Per the stop rule the design must keep fail-closed handling; the observed behavior is not a guarantee at other sizes. |
| Explicit zero-detection representation | **PASS (observed)** | The flat-gray image returned a full group (`image_path`, `width`, `height`, `class_names`) with `outputs: []` — distinguishable from a missing group. |
| Reordered result groups | **UNPROVEN** | Returned order equalled submitted order in runs A and B (natural behavior); order cannot be forced, so order-independence is only exercised by the adapter's own unit test, not by the service. |
| Missing result group | **PASS for the one natural trigger; otherwise UNPROVEN** | Unreachable input (run D): no partial output — the whole task ended `failed` with `output:null`. A task that succeeds with fewer groups than inputs was not observed and cannot be manufactured. |
| Duplicate result groups | **PASS (observed for duplicate inputs)** | Submitting the same URL twice (run C) returned **two** groups with identical `image_path` (both matching submitted index 0) — indistinguishable, so duplicate inputs must be rejected before POST (the adapter's `byDigest.size !== submitted.length` guard already does this). Duplicate groups for distinct inputs were not observed. |
| Unknown result group (a path not among the inputs) | **UNPROVEN** | Not observed; cannot be manufactured. |
| Independent groups may proceed when another is bad | **UNPROVEN** | Not observable: an unreachable input fails the whole task; a per-group failure inside a successful task was never seen. Until proven, unresolved inputs must fail closed. |
| Same-filename inputs never confused | **PASS (observed)** | Three objects named `img.jpg` mapped correctly by full URL. |

## Consequences for the design (evidence-based, not assumptions)

1. Correlation by exact `image_path` digest is workable at N=3 and stays the only allowed scheme; keep whole-envelope fail-closed for unknown/ambiguous/duplicate groups.
2. A batch is **atomic at the provider for source failures**: one unreachable input fails every input. Per-Asset partial outcomes therefore arise only from write-time policy (frozen Asset, source changed), not from provider partial results — the plan's per-input outcome model must not assume the provider returns partial success.
3. Because a failing input poisons the batch, pre-dispatch verification of each source (existence, accessibility) is more valuable than assumed (T026/T028).

Gate status: **E2 PARTIAL** — observed correlation PASS; contractual guarantee, reordering, unknown-group and partial-group behavior UNPROVEN; N>3 UNPROVEN.
