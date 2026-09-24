# T170 — production-style multi-user browser acceptance pass

Date: 2026-09-24.

**Status: NOT ATTEMPTED — genuinely blocked, not a skipped-for-convenience item.**

This task asks for quickstart.md's full 7-scenario set run through two real, concurrent browser sessions against the real Postgres/Redis/MinIO/worker environment. This session has no browser-automation tooling available (no Playwright/Puppeteer/Selenium driver, no way to open and drive an actual browser window, let alone two concurrent authenticated sessions). Every other UI-interaction test gap noted throughout this feature's implementation (T084, T096, T147, T151's audit) traces back to the same root cause: this repo has no `@testing-library/react` or browser-automation dependency, and AGENTS.md requires explicit permission before adding one.

**What this session *did* verify, as the closest available substitute**:
- Every server-side command, route, and service path a real browser session would exercise is proven against real Postgres/MinIO/Redis through the `apps/web/tests/text-*` and `apps/worker/tests/queue/text-*` suites (see [checks.md](checks.md) and this file's sibling verification documents).
- The dev-stack's `web`/`worker`/`realtime` containers are live and healthy (see [compose-normal.md](compose-normal.md)), so the application itself is running and reachable — just not driven by this session through an actual browser.

**What remains a real gap**: this does not substitute for actually clicking through the UI with two concurrent sessions and confirming the visual/interactive result matches quickstart.md's scenarios end to end (e.g., does the Highlight Span tool actually highlight correctly on screen, does presence actually render two distinct avatars). That requires either browser-automation tooling being added to this repo (a decision for whoever owns that call, not this session) or a person manually walking through quickstart.md's scenarios in a real browser.
