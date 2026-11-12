import { createServer, type Server } from "node:http";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";

export interface HealthChecks {
  nats: () => boolean;
  database: () => Promise<void>;
  /** Shards leased by this instance and which of them have a ready gateway session. */
  shards: () => { owned: number[]; ready: number[] };
}

/**
 * GET /healthz  liveness: the process is up.
 * GET /readyz   readiness: NATS + Postgres reachable and every leased shard connected.
 *               An instance with no shards (a hot standby) is still ready.
 * GET /metrics  Prometheus exposition.
 */
export function startHttpServer(opts: {
  port: number;
  metrics: Metrics;
  checks: HealthChecks;
  beforeScrape?: () => void;
  logger: Logger;
}): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      switch (req.url?.split("?")[0]) {
        case "/healthz":
          return send(200, { status: "ok" });
        case "/readyz": {
          const nats = opts.checks.nats();
          const database = await opts.checks
            .database()
            .then(() => true)
            .catch(() => false);
          const { owned, ready } = opts.checks.shards();
          const shardsReady = owned.every((s) => ready.includes(s));
          const ok = nats && database && shardsReady;
          return send(ok ? 200 : 503, { status: ok ? "ready" : "not ready", nats, database, shards: { owned, ready } });
        }
        case "/metrics":
          opts.beforeScrape?.();
          return send(200, await opts.metrics.registry.metrics(), opts.metrics.registry.contentType);
        default:
          return send(404, { error: "not found" });
      }
    } catch (err) {
      opts.logger.error({ err, url: req.url }, "http handler failed");
      send(500, { error: "internal error" });
    }
  });
  return new Promise((resolve) =>
    server.listen(opts.port, () => {
      opts.logger.info({ port: opts.port }, "http server listening");
      resolve(server);
    }),
  );
}
