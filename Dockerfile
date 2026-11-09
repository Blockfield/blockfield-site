FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.18.0 && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime-base
LABEL org.opencontainers.image.source="https://github.com/Blockfield/blockfield-site"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.18.0 && pnpm install --prod --frozen-lockfile && pnpm store prune
# No persistent local volume: statistics live in PostgreSQL. Do not commit real tokens, put them in client configs, or print them.
USER node
# Last layer: a new commit must not invalidate the dependency cache above.
ARG BUILD_COMMIT
ENV BUILD_COMMIT=$BUILD_COMMIT
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:4321/ || exit 1
CMD ["node", "./dist/server/entry.mjs"]

# CI consumes the Astro output built and checked in the same job.
FROM runtime-base AS ci
COPY dist/ ./dist/

FROM runtime-base AS runtime
COPY --from=build /app/dist ./dist
