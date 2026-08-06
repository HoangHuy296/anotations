FROM node:22-bookworm-slim AS base

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssl \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @fieldframe/domain build \
  && pnpm --filter @fieldframe/queue build \
  && pnpm --filter @fieldframe/worker build

RUN mkdir -p apps/worker/dist/lib/generated/prisma \
  && cp lib/generated/prisma/*.so.node \
    apps/worker/dist/lib/generated/prisma/

CMD ["pnpm", "--filter", "@fieldframe/worker", "start"]
