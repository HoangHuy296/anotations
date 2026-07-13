# Fieldframe

Fieldframe is a Gitea-backed image annotation workspace built as one Next.js
application. Gitea remains the source of truth for source images, while
PostgreSQL stores datasets, labels, annotations, review state, and export jobs.

The current implementation includes:

- Responsive dashboard and three-panel annotation workspace shell.
- PostgreSQL schema and Prisma migrations.
- Idempotent development seed.
- Label creation, editing, and protected deletion.
- Server-side Zod validation and role-checked Server Actions.
- Trusted reverse-proxy identity enforcement.
- Server-only Gitea repository, tree, and import-preview APIs.
- Transactional repository, dataset, and image metadata imports.
- Database-backed dataset list, workspace sidebar, search, and status filters.
- Protected image delivery through a local-cache storage abstraction.
- Client-only Konva viewport with fit, zoom, and native drag-to-pan.

See [the architecture documentation](docs/architecture/README.md) for system
boundaries, security decisions, data flows, and the phase roadmap.

## Phase 1 local foundation

The project is a pnpm workspace. `apps/web` is the only browser-facing Next.js
application; `apps/worker` is a private process with no HTTP listener. The
local Compose topology provides `web`, `worker`, PostgreSQL, MinIO, and Redis.

Copy `.env.example` to an ignored local `.env` file and set the provider values
before starting the stack. Use the internal service hostnames shown in the
example when running in Compose. Do not commit `.env` or expose any value from
it to browser code.

```bash
pnpm install
pnpm db:generate
docker compose -f docker-compose.yaml config
docker compose -f docker-compose.yaml up --build
docker compose -f docker-compose.yaml ps
docker compose -f docker-compose.yaml down
```

The web readiness endpoint is `/api/health`. It returns only a status label;
the private worker reports readiness through sanitized container logs.

## Foundation requirements

- Node.js 22.13 or newer and pnpm 11.10.0.
- Docker Engine with Compose v2 for the local provider stack.

Run Prisma only from the workspace root. `pnpm db:generate` writes the client
to `lib/generated/prisma`; web code imports it through `@internal/db`, and the
private worker imports the generated client directly. Generation does not alter
`prisma/schema.prisma` or existing migrations.

## Environment

Copy `.env.example` to `.env.local` and replace the example values:

```bash
cp .env.example .env.local
```

Required now:

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fieldframe?schema=public"
```

Prisma CLI explicitly loads the ignored `.env` file. Hosted PostgreSQL URLs
automatically receive `sslmode=require` when no SSL mode is supplied, while
localhost connections remain unchanged. Both Prisma CLI and the Next.js
runtime use the same normalized connection.

If a provider supplies separate `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
and `PGDATABASE` values, combine them into one URL-encoded `DATABASE_URL`.
Keep only one active `DATABASE_URL` entry to avoid environment precedence
confusion.

Gitea values are server-only:

```dotenv
GITEA_BASE_URL="https://gitea.example.internal"
GITEA_ACCESS_TOKEN="replace-with-a-server-side-token"
```

Never prefix Gitea credentials with `NEXT_PUBLIC_`.

Production also requires a shared secret injected by the trusted reverse
proxy:

```dotenv
AUTH_EMAIL_HEADER="x-auth-request-email"
AUTH_PROXY_SECRET_HEADER="x-fieldframe-proxy-secret"
AUTH_PROXY_SECRET="replace-with-a-long-random-shared-secret"
```

The proxy must strip client-supplied identity and secret headers before
injecting its own values. The Next.js origin must not be publicly reachable.

## Database setup

Generate the Prisma client, apply migrations, and seed labels:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

The seed always upserts four starter labels. To also seed a development
administrator, configure:

```dotenv
DEV_AUTH_EMAIL="operator@example.com"
SEED_ADMIN_EMAIL="operator@example.com"
SEED_ADMIN_NAME="Development Operator"
```

`DEV_AUTH_EMAIL` is ignored in production. Production identity must come from
the trusted reverse proxy headers. In development, the app falls back to
`developer@localhost` when no identity is configured, keeping the dashboard
available. Configure and seed `DEV_AUTH_EMAIL` to exercise role-protected
database mutations.

## Development

```bash
npm install
npm run dev
```

Open:

- `http://localhost:3000/dashboard`
- `http://localhost:3000/labels`
- `http://localhost:3000/datasets`

## Label management

The labels page reads directly from PostgreSQL. Creating, editing, or deleting
a label requires a database user with the `ADMIN` or `REVIEWER` role.

Validation rules:

- Names contain 2–50 characters and are unique case-insensitively.
- Colors use six-digit hexadecimal notation.
- Descriptions contain at most 280 characters.
- Hotkeys are optional single letters or numbers and must be unique.
- A label assigned to any annotation cannot be deleted.

Every Server Action repeats authorization and Zod validation. UI visibility or
disabled controls are never treated as security boundaries.

## Gitea integration

All Gitea traffic is issued by the server-only client in `src/lib/gitea.ts`.
Browser code must never call a private Gitea instance directly.

Available authenticated endpoints:

```text
GET  /api/gitea/repos?page=1&limit=30
GET  /api/gitea/repos/{owner}/{repo}/tree?ref=main&path=images
POST /api/gitea/import
```

The import endpoint currently validates a proposed dataset and returns up to
100 discovered image candidates:

```json
{
  "owner": "vision-lab",
  "repo": "training-images",
  "branch": "main",
  "rootPath": "urban",
  "name": "street-scenes-q2"
}
```

The imports page first requests a preview and only enables persistence when the
tree is complete, contains supported images, and remains under the 2,000-image
limit. Confirmed imports transactionally upsert:

- the authenticated local user;
- environment-backed Gitea connection metadata, without copying the token;
- repository and dataset provenance;
- image paths, MIME types, byte sizes, and Gitea SHAs.

Re-importing the same repository, branch, and root path updates source metadata
without resetting existing image annotation statuses.

Gitea requests have fixed server credentials, no-store caching, a 12-second
timeout, bounded JSON responses, tree-entry limits, path traversal rejection,
and sanitized error responses.

## Dataset workspace

`/datasets` lists persisted imports and progress derived from image statuses.
Opening a dataset loads up to 250 matching images into the workspace sidebar.
The sidebar supports case-insensitive filename search and all six workflow
statuses:

- Not started
- Auto-detected
- In progress
- Review pending
- Manually verified
- Rejected

Imported image dimensions remain pending until the protected source is decoded
for the first time in the Phase 6 canvas.

## Image delivery and canvas

`GET /api/images/{imageId}/content` authorizes the request, resolves repository
provenance from PostgreSQL, and serves image bytes from a private local cache.
On a cache miss it fetches the raw file through the server-only Gitea client.
Cached files live under `.data/storage` by default and never under `public/`.

The local provider implements the shared storage contract and can later be
replaced by S3 or MinIO. Cache keys include the image ID and Gitea SHA, so a
source update naturally creates a fresh object.

The annotation workspace now:

- loads react-Konva only in the browser;
- fits the selected image to the available viewport;
- supports toolbar and wheel-centered zoom;
- pans with Konva-native dragging;
- records decoded image dimensions through an authenticated API;
- keeps viewport interactions separate from annotation persistence.

Source files are limited to 25 MB. Bounding-box creation and editing remain
Phase 7 work.

## Commands

```bash
npm run dev          # Start Next.js development mode
npm run build        # Create a production build
npm run start        # Run the production server
npm run lint         # Run ESLint
npm run db:generate  # Generate Prisma Client
npm run db:migrate   # Apply development migrations
npm run db:seed      # Run the idempotent seed
npm run db:studio    # Open Prisma Studio
```

## Security notes

- Gitea requests must only originate from server-side modules.
- Private files and exports must not be stored under `public/`.
- The production Next.js origin must only be reachable through the trusted
  authenticated reverse proxy.
- Protected pages and API routes are covered by `src/proxy.ts`.
- Route Handlers and Server Actions repeat identity and role checks rather
  than trusting proxy coverage alone.
- When `DATABASE_URL` is absent, database-backed pages render a setup state
  without issuing Prisma queries. The local fallback identity also avoids a
  database lookup, preventing development-only `user.findUnique()` failures.
