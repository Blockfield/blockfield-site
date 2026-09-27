FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/Blockfield/blockfield-site"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# A new named volume copies this ownership; without it the stats DB is root-owned and reads return 503.
RUN mkdir -p /data/stats && chown node:node /data/stats
USER node
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:4321/ || exit 1
CMD ["node", "./dist/server/entry.mjs"]
