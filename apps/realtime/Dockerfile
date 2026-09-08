FROM node:22-bookworm-slim
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/realtime/package.json apps/realtime/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN pnpm install --frozen-lockfile
COPY . .
EXPOSE 3002
CMD ["pnpm", "--filter", "@annotationplatform/realtime", "start"]
