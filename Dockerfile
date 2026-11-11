# --- Build stage: bundle the TypeScript sources with Bun ---------------------
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json index.ts ./
COPY src ./src
RUN bun run typecheck && bun run build

# --- Runtime stage: run the single-file bundle on plain Node -----------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    ICAL_PATH=/data/ical
COPY --from=build /src/release/index.mjs ./index.mjs
RUN mkdir -p /data/ical && chown -R node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "index.mjs"]
