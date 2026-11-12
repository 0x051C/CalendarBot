import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "calendarbot_" });

  return {
    registry,
    alerts: new Counter({
      name: "calendarbot_alerts_total",
      help: "Event alerts by outcome",
      labelNames: ["result"] as const,
      registers: [registry],
    }),
    leaseEvents: new Counter({
      name: "calendarbot_shard_lease_events_total",
      help: "Shard lease transitions on this instance",
      labelNames: ["event"] as const,
      registers: [registry],
    }),
    interactions: new Counter({
      name: "calendarbot_interactions_total",
      help: "Handled Discord interactions",
      labelNames: ["kind", "outcome"] as const,
      registers: [registry],
    }),
    shardsOwned: new Gauge({ name: "calendarbot_shards_owned", help: "Shards leased by this instance", registers: [registry] }),
    clusterInstances: new Gauge({ name: "calendarbot_cluster_instances", help: "Live instances seen in the cluster", registers: [registry] }),
    shardReady: new Gauge({
      name: "calendarbot_shard_ready",
      help: "1 when the shard's gateway session is ready",
      labelNames: ["shard"] as const,
      registers: [registry],
    }),
    gatewayPing: new Gauge({
      name: "calendarbot_gateway_ping_ms",
      help: "Gateway heartbeat latency per shard",
      labelNames: ["shard"] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
