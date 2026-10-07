# A2 import manifest (selective A2/S0 import)

Machine-readable source of truth: [a2-import-manifest.json](./a2-import-manifest.json). Base: `c46c928e07a5cfeac2672532066a28bea3755c52`. Source basis: `a5aa248` (tree `ebf2f89204c96e21bc2152342acc790aa57b482f`) plus the explicitly listed dirty snapshots of the canonical `a2/s0-storage-authority` checkout.

**Not a cherry-pick and not a merge.** Historical S0 proof `authoritative-20261006T120356Z-127c23c2` (111/111) hash-binds only eight policy/provisioning artifacts; every other file is classified below. The negative scope invariant of the frozen contract (§1.1) keeps `release/shared-dev-execution-package.md` out of this lineage.

| Target path | Mode | Proof classification | Source SHA-256 | Resulting SHA-256 |
| --- | --- | --- | --- | --- |
| `scripts/db-safety/minio-authority.mjs` | DIRTY_PROVEN_SNAPSHOT | S0_EXECUTED_NOT_HASH_BOUND | `f9001037ea481483…` | `f9001037ea481483…` |
| `scripts/db-safety/minio-authority-s0.mjs` | DIRTY_PROVEN_SNAPSHOT | S0_EXECUTED_NOT_HASH_BOUND | `d34204b9dc013a6b…` | `d34204b9dc013a6b…` |
| `scripts/db-safety/minio-authority-verify.mjs` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `4042edcf37a4df43…` | `4042edcf37a4df43…` |
| `scripts/db-safety/minio-write-audit.mjs` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `ecfe74b488a87d64…` | `ecfe74b488a87d64…` |
| `scripts/db-safety/minio-write-audit.allowlist.json` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `00d681262d0a1845…` | `00d681262d0a1845…` |
| `scripts/db-safety/minio-authority/deprovision.sh` | EXACT | S0_HASH_BOUND | `25c9f09314978b55…` | `25c9f09314978b55…` |
| `scripts/db-safety/minio-authority/lifecycle.json` | EXACT | S0_HASH_BOUND | `736b4b890c9d2bb1…` | `736b4b890c9d2bb1…` |
| `scripts/db-safety/minio-authority/policy-verifier.json` | EXACT | S0_HASH_BOUND | `ac0e1c7dd4590d89…` | `ac0e1c7dd4590d89…` |
| `scripts/db-safety/minio-authority/provision.sh` | EXACT | S0_HASH_BOUND | `1d2e05bb3a346fdd…` | `1d2e05bb3a346fdd…` |
| `scripts/db-safety/minio-authority/snapshot.sh` | EXACT | S0_HASH_BOUND | `a819e35e083913bd…` | `a819e35e083913bd…` |
| `scripts/db-safety/minio-authority/frozen-images.json` | DIRTY_PROVEN_SNAPSHOT | S0_HASH_BOUND | `5d3866d0161d46d6…` | `5d3866d0161d46d6…` |
| `scripts/db-safety/minio-authority/policy-web.json` | DIRTY_PROVEN_SNAPSHOT | S0_HASH_BOUND | `23ce76efdaf62f25…` | `23ce76efdaf62f25…` |
| `scripts/db-safety/minio-authority/policy-worker.json` | DIRTY_PROVEN_SNAPSHOT | S0_HASH_BOUND | `4ee7d65676b13e0d…` | `4ee7d65676b13e0d…` |
| `scripts/db-safety/tests/minio-authority.test.mjs` | DIRTY_PROVEN_SNAPSHOT | S0_EXECUTED_NOT_HASH_BOUND | `aada435833a5c2e6…` | `aada435833a5c2e6…` |
| `apps/worker/src/providers/sealed-namespace.ts` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `5cc570b57b60f6b6…` | `5cc570b57b60f6b6…` |
| `apps/worker/src/providers/minio.ts` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `4c2500d4cc200013…` | `4c2500d4cc200013…` |
| `apps/worker/src/providers/index.ts` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `4030d005f30902d4…` | `4030d005f30902d4…` |
| `apps/worker/src/readiness.ts` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `0c01df64b3685548…` | `0c01df64b3685548…` |
| `apps/worker/src/jobs/bulk-delete-assets.ts` | EXACT | S0_EXECUTED_NOT_HASH_BOUND | `9670ac7f1fdaf78b…` | `9670ac7f1fdaf78b…` |
| `apps/worker/tests/queue/sealed-namespace.test.ts` | DIRTY_PROVEN_SNAPSHOT | S0_EXECUTED_NOT_HASH_BOUND | `2b23c021fc2df019…` | `2b23c021fc2df019…` |
| `specs/029-modality-specific-datasets/contracts/premedia-verification-a2.md` | DIRTY_PROVEN_SNAPSHOT | FROZEN_SPEC | `6f7339a00b0c5854…` | `6f7339a00b0c5854…` |
| `specs/029-modality-specific-datasets/release/s0-storage-authority.md` | DIRTY_PROVEN_SNAPSHOT | FROZEN_SPEC | `27dcad7fab0553a0…` | `27dcad7fab0553a0…` |
| `specs/029-modality-specific-datasets/release/disposable-http-runtime-plan.md` | DIRTY_PROVEN_SNAPSHOT | FROZEN_SPEC | `a98d6963eba543c4…` | `a98d6963eba543c4…` |
| `scripts/db-safety/commands.json` | SELECTIVE_HUNKS | SELECTIVE_INTEGRATION | `4ea80e937e46366d…` | `93bed858ccae0c85…` |
| `scripts/db-safety/disposable-test.mjs` | SELECTIVE_HUNKS | SELECTIVE_INTEGRATION | `62fdc5cc60eb6fc9…` | `e0576fd95983ccdf…` |

Full 64-hex hashes, per-file source basis and the exclusion list are in the JSON manifest.

