import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import type { Logger } from "../logger";

/** Discord's identify rate-limit window, plus a little slack. */
const IDENTIFY_WINDOW_MS = 5_500;

export interface ClusterBuckets {
  /** Shard leases: `shard.<id>` → instance id (TTL = lease TTL). */
  leases: KV;
  /** Instance presence heartbeats (TTL = lease TTL). */
  instances: KV;
  /** Gateway identify slots (TTL = Discord's 5s window). */
  identify: KV;
  /** Durable cluster-wide settings, e.g. the agreed shard count. */
  config: KV;
}

export async function connectNats(url: string, instanceId: string, logger: Logger): Promise<NatsConnection> {
  const nc = await connect({
    servers: url.split(",").map((s) => s.trim()),
    name: `calendarbot:${instanceId}`,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1_000,
  });
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === "disconnect" || s.type === "reconnect" || s.type === "error") {
        logger.warn({ status: s.type }, "nats connection status changed");
      }
    }
  })();
  logger.info({ server: nc.getServer() }, "connected to nats");
  return nc;
}

export async function openBuckets(nc: NatsConnection, cluster: string, leaseTtlMs: number): Promise<ClusterBuckets> {
  const kvm = new Kvm(nc);
  // `create` is idempotent for identical settings and binds to an existing bucket.
  const [leases, instances, identify, config] = await Promise.all([
    kvm.create(`${cluster}_shard_leases`, { ttl: leaseTtlMs, history: 1 }),
    kvm.create(`${cluster}_instances`, { ttl: leaseTtlMs, history: 1 }),
    kvm.create(`${cluster}_identify`, { ttl: IDENTIFY_WINDOW_MS, history: 1 }),
    kvm.create(`${cluster}_config`, { history: 5 }),
  ]);
  return { leases, instances, identify, config };
}

/**
 * Every instance must use the same shard count. The first instance to boot
 * stores its value; later instances adopt the stored one.
 */
export async function agreeOnShardCount(
  config: KV,
  resolveLocal: () => Promise<number>,
  logger: Logger,
): Promise<number> {
  const existing = await config.get("shard_count");
  if (existing?.operation === "PUT") {
    const stored = Number(existing.string());
    logger.info({ shardCount: stored }, "using cluster shard count");
    return stored;
  }
  const local = await resolveLocal();
  try {
    await config.create("shard_count", String(local));
    logger.info({ shardCount: local }, "initialised cluster shard count");
    return local;
  } catch {
    return agreeOnShardCount(config, resolveLocal, logger); // lost the race; read the winner's value
  }
}
