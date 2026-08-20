FROM node:22-bookworm-slim AS base

WORKDIR /workspace
RUN apt-get update \
  && apt-get install --no-install-recommends -y openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN cp lib/generated/prisma/*.so.node lib/generated/
RUN pnpm --filter @annotationplatform/domain build \
  && pnpm --filter @annotationplatform/queue build \
  && pnpm --filter @annotationplatform/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@annotationplatform/web", "start"]
