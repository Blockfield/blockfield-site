FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.18.0 && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/Blockfield/blockfield-site"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.18.0 && pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist
# A new named volume copies this ownership; without it the stats DB is root-owned and reads return 503.
RUN mkdir -p /data/stats && chown node:node /data/stats
USER node
# Last layer: a new commit must not invalidate the dependency cache above.
ARG BUILD_COMMIT
ENV BUILD_COMMIT=$BUILD_COMMIT
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:4321/ || exit 1
CMD ["node", "./dist/server/entry.mjs"]
