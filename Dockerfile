# Production image: API + voice WebSocket + CRM static files, one process.
# Target: Fly.io Mumbai (bom) or any always-on Docker host in India.
FROM node:24-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=8080
ENV BASE_PATH=/

RUN pnpm exec tsc -b lib/db lib/api-zod lib/api-client-react \
  && pnpm --filter @workspace/api-server run build \
  && pnpm --filter @workspace/shubham-motors run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV BASE_PATH=/
ENV STATIC_DIR=/app/public

RUN addgroup --system sakshi && adduser --system --ingroup sakshi sakshi

COPY --from=build /app/artifacts/api-server/dist ./dist
COPY --from=build /app/artifacts/shubham-motors/dist/public ./public

USER sakshi
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
