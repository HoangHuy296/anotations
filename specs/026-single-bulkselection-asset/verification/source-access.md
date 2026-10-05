# T006 (E3) — scoped MinIO download from the AI Service network

Date: 2026-09-24. Redacted: signed-URL query strings, endpoint values (both endpoints are private-LAN addresses over plain `http`; the configured `MINIO_PUBLIC_ENDPOINT` is what is signed).

| Requirement | Result | Evidence |
| --- | --- | --- |
| AI Service can fetch an object-scoped signed URL generated with the production signer settings (`presignedGetObject(bucket,key,20*60)` against `MINIO_PUBLIC_ENDPOINT`) | **PASS** | Runs A, B, C: the service returned per-image `width`/`height` equal to the uploaded files (810×1080, 1280×720, 640×480) — it downloaded and decoded each object. Signing at 07:29:11.150Z, create 07:29:11.212Z, success 14.1 s later. |
| Access uses no browser cookie, public bucket or permanent link | **PASS** | Objects were in the private bucket; only the 20-minute scoped GET link was supplied. |
| Signed link stays out of stored/visible records | **PASS in this run / rule proven necessary** | Evidence was redacted; provider error text echoed the full signed URL (provider-contract.md F2), so raw provider errors must never be stored or displayed. |
| Unreachable object → durable failure | **PASS** | Task D (valid signature, object absent → 404): provider retried internally (~54 s) and ended `status:"failed"`, `output:null`, `error:"Failed to access URL <url>: 404 …"`. The **whole task** failed; the valid input in the same task produced no output. |
| Download window vs the 20-minute TTL | **UNPROVEN** | Observed fetch time ≤ 14 s for 3 images (≈0.9 MB) and a 54 s provider retry window for an unreachable URL. Fetch time for the verified maximum batch and for larger objects (video) was not measured. |
| Expired-link behavior | **UNPROVEN** | Not exercised (a short-TTL probe would need one more external task). |
| Reachability from the AI Service's *own* network | **PASS for this topology** | The fetch was performed by the deployed service (the worker was not involved). Both services are addressed on private LAN IPs; whether they share a host or subnet is not observable from this run. |

Conclusion: E3 is **PARTIALLY PROVEN** — reachability PASS; TTL sufficiency at the maximum batch and expiry behavior remain UNPROVEN.
