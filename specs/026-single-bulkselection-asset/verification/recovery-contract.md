# T007 — submission idempotency, retry and cancellation evidence

Date: 2026-09-24.

| Requirement | Result | Evidence |
| --- | --- | --- |
| Idempotency key / lookup by client id | **PASS (absent)** | The complete deployed OpenAPI has neither parameter nor route (provider-contract.md). |
| Lost-response retry behavior | **PASS (observed: duplicates are created)** | Run B re-sent the byte-identical body of run A: HTTP 202 with a **different** `task_id` (`49d26d2f-…` vs `91d0b23e-…`), same results. A blind retry after an unknown outcome therefore creates a second external task. This justifies the fail-closed `AIOZ_SUBMISSION_AMBIGUOUS` policy; it cannot be reconciled by asking the provider. |
| Known task id reuse | **PASS** | `GET /api/v1/tasks/result/{task_id}` returned the same terminal result on repeated reads (used by the poll loop). Poll timing: statuses were stable between reads. |
| Provider cancellation | **PASS (unsupported)** | No cancel path exists in the deployed OpenAPI. Cancellation must stay local (stop polling, fence writes); an external task may keep running. |
| Lookup/list of tasks to reconcile an ambiguous submission | **PASS (absent)** | No list route exists; an unknown-outcome submission cannot be discovered. |
| Behavior when the model id is unknown | **PASS (observed)** | `422 {"detail":"Model with ID … does not exist in the database."}` before any task is created. |
| Transient system failure recovery (`failed_system`) | **UNPROVEN** | Observed only as a stage of a task that ended `failed`; see provider-contract.md F3. |
| Provider task retention / how long a result stays readable | **UNPROVEN** | Not measured. |

Cost of this run: 5 create requests (1 rejected 422, 4 accepted tasks: A, B, C, D).
