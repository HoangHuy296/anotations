# Setup runtime evidence

Local Node and both running web/worker containers match Node 22.23.1 / ICU 78.2 / Unicode 17.0. Browser: Chrome 151.0.7922.137. Exact image IDs and config/lockfile/source hashes are recorded in [runtime-profile.json](runtime-profile.json). These are the observed baseline images, not a claim that Phase 025 is deployed. Worker artifact identity is finalized by T030. The benchmark generator passes source hash/length, nesting, endpoint uniqueness, determinism and mismatch rejection tests. The two-host latency environment is not yet certified.

Configured database read-only inventory: total TEXT=3, object-only=3, inline-only=0, both=0, neither=0, with annotations=0. No domain writes or source-byte reads were performed for this aggregate inventory. No conflicting legacy population was observed. Re-inventory another rollout target before applying migrations.

Commands executed: Node fixture/property tests and domain typecheck; read-only Prisma inventory; docker container image IDs and Node profile reads. No secret values captured.
