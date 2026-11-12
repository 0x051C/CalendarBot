# --- Build: typecheck and bundle with Bun ------------------------------------
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN bun run typecheck && bun run build

# --- Runtime: single-file bundle + SQL migrations on plain Node ---------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    ICAL_PATH=/data/ical \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build /src/release/main.mjs ./main.mjs
COPY --from=build /src/release/drizzle ./drizzle
RUN mkdir -p /data/ical && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "main.mjs"]
