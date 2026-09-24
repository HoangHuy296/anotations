# T166 — normal Compose validation

Date: 2026-09-24.

```
$ docker compose -f docker-compose.yaml config --quiet
(exit 0, no output -- config is syntactically/referentially valid; --quiet deliberately used so no resolved config, and therefore no credential, is ever printed)
```

**Result**: PASS.

**Service health**: this repo's normal dev stack has been running live throughout this entire session (not a fresh isolated boot for this check specifically — see the note below on why a second boot was not attempted):

```
$ docker compose -f docker-compose.yaml ps --format "table {{.Service}}\t{{.Status}}"
SERVICE          STATUS
gitea            Up 20 hours (healthy)
gitea-postgres   Up 20 hours (healthy)
github-fixture   Up 20 hours
minio            Up 20 hours (healthy)
postgres         Up 20 hours (healthy)
realtime         Up 20 hours (healthy)
redis            Up 20 hours (healthy)
web              Up 31 minutes
worker           Up 20 hours
```

All services with a defined healthcheck report `healthy`. Every TEXT-annotations/workflow/collaboration/worker-queue integration test executed throughout this session (well over 100 tests across `text-annotations`, `text-workflow`, `text-collaboration`, `text-accessibility`, and the worker `test:queue` suite) ran against exactly this `web`/`worker`/`postgres`/`minio`/`redis`/`realtime` set — every one of those passing runs is itself live evidence the normal Compose topology serves real traffic to real services correctly, not merely that its YAML parses.

**Not attempted**: booting a *second*, fresh isolated instance of this same stack. The live stack above already constitutes the smoke-boot evidence this task asks for; starting a duplicate risks port conflicts with the instance this session (and the person using this machine) is actively relying on, which is a real, unnecessary risk for evidence this session's test runs already provide.
