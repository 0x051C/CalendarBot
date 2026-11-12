import { EventEmitter } from "node:events";
import type { KV } from "@nats-io/kv";
import type { Logger } from "../logger";

export interface ShardCoordinatorOptions {
  /** Bucket of shard leases (`shard.<id>` → instance id). Its TTL is the lease TTL. */
  leases: KV;
  /** Bucket of live instances (`<instance id>` → heartbeat JSON), same TTL. */
  instances: KV;
  instanceId: string;
  shardCount: number;
  leaseTtlMs: number;
  logger: Logger;
}

export type ReleaseReason = "rebalance" | "lost" | "shutdown";

interface Lease {
  revision: number;
  lastRenewedAt: number;
}

interface CoordinatorEvents {
  acquired: [shardId: number];
  released: [shardId: number, reason: ReleaseReason];
}

const leaseKey = (shardId: number) => `shard.${shardId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Distributes Discord gateway shards across instances using NATS KV leases.
 *
 * - Claim:   `create(shard.N)`, which only succeeds if nobody holds the key.
 * - Renew:   `update(shard.N, revision)`, which fails if someone else took over.
 * - Expire:  the bucket TTL drops leases whose owner stopped renewing.
 * - Balance: instances publish their shard count in a presence heartbeat;
 *            each aims for floor/ceil(shards / live instances), and when one
 *            is starved the most-loaded instance yields one shard per tick.
 * - Fence:   an instance that cannot renew for ~80% of the TTL drops the shard
 *            itself, before another instance can legitimately claim it.
 */
export class ShardCoordinator extends EventEmitter<CoordinatorEvents> {
  private readonly owned = new Map<number, Lease>();
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickInFlight: Promise<void> | null = null;
  private liveInstanceCount = 1;

  constructor(private readonly opts: ShardCoordinatorOptions) {
    super();
  }

  get instanceId() {
    return this.opts.instanceId;
  }
  get shardCount() {
    return this.opts.shardCount;
  }
  get liveInstances() {
    return this.liveInstanceCount;
  }
  ownedShards(): number[] {
    return [...this.owned.keys()].sort((a, b) => a - b);
  }
  owns(shardId: number): boolean {
    return this.owned.has(shardId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.tickInFlight = this.tick().catch((err) =>
        this.opts.logger.error({ err }, "shard coordinator tick failed"),
      );
      await this.tickInFlight;
      this.tickInFlight = null;
      if (this.running) this.timer = setTimeout(loop, this.tickIntervalMs);
    };
    void loop();
  }

  /** Stop renewing and hand every lease back so other instances take over immediately. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.tickInFlight;
    for (const [shardId, lease] of this.owned) {
      this.owned.delete(shardId);
      this.emit("released", shardId, "shutdown");
      await this.opts.leases
        .delete(leaseKey(shardId), { previousSeq: lease.revision })
        .catch(() => {});
    }
    await this.opts.instances.delete(this.opts.instanceId).catch(() => {});
  }

  private get tickIntervalMs() {
    return Math.max(500, Math.floor(this.opts.leaseTtlMs / 3));
  }

  /** One coordination round. Public for tests. */
  async tick(): Promise<void> {
    await this.heartbeat();
    await this.renewLeases();
    const load = await this.readPresence();
    this.liveInstanceCount = load.size;
    await this.balance(load);
  }

  private async heartbeat() {
    try {
      await this.opts.instances.put(
        this.opts.instanceId,
        JSON.stringify({ shards: this.ownedShards(), startedAt: this.startedAt, at: Date.now() }),
      );
    } catch (err) {
      this.opts.logger.warn({ err }, "presence heartbeat failed");
    }
  }

  private async renewLeases() {
    const now = Date.now();
    for (const [shardId, lease] of [...this.owned]) {
      try {
        lease.revision = await this.opts.leases.update(leaseKey(shardId), this.opts.instanceId, lease.revision);
        lease.lastRenewedAt = now;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/wrong last sequence|key not found/i.test(msg)) {
          this.opts.logger.warn({ shardId }, "shard lease lost to another instance");
          this.drop(shardId, "lost");
        } else if (now - lease.lastRenewedAt > this.opts.leaseTtlMs * 0.8) {
          this.opts.logger.error({ shardId, err }, "cannot renew shard lease; fencing self");
          this.drop(shardId, "lost");
        } else {
          this.opts.logger.warn({ shardId, err }, "shard lease renewal failed; will retry");
        }
      }
    }
  }

  /** Live instances and how many shards each reported in its last heartbeat. */
  private async readPresence(): Promise<Map<string, number>> {
    const load = new Map<string, number>();
    for await (const id of await this.opts.instances.keys()) {
      if (id === this.opts.instanceId) continue;
      const entry = await this.opts.instances.get(id).catch(() => null);
      if (entry?.operation !== "PUT") continue;
      try {
        load.set(id, (entry.json() as { shards?: number[] }).shards?.length ?? 0);
      } catch {
        load.set(id, 0);
      }
    }
    load.set(this.opts.instanceId, this.owned.size);
    return load;
  }

  private async heldShards(): Promise<Set<number>> {
    const held = new Set<number>();
    for await (const key of await this.opts.leases.keys("shard.>")) {
      held.add(Number(key.slice("shard.".length)));
    }
    return held;
  }

  /**
   * Fair share: every instance ends up with `floor` or `floor + 1` shards
   * (floor = shards / instances, rounded down).
   */
  private async balance(load: Map<string, number>) {
    const n = load.size;
    const floor = Math.floor(this.opts.shardCount / n);
    const ceil = floor + (this.opts.shardCount % n === 0 ? 0 : 1);
    const mine = this.owned.size;

    // Hold too many outright, or a starved instance exists and we are the
    // most loaded (ties broken by id, so exactly one instance yields per tick).
    const starved = [...load.values()].some((c) => c < floor);
    const [mostLoaded] = [...load].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shouldYield =
      mine > ceil || (starved && mine > floor && mostLoaded?.[0] === this.opts.instanceId);

    if (shouldYield) {
      // Give back one shard per tick so the cluster converges without flapping.
      const shardId = Math.max(...this.owned.keys());
      const lease = this.owned.get(shardId)!;
      this.opts.logger.info({ shardId, floor, ceil, instances: n }, "releasing shard to rebalance");
      this.drop(shardId, "rebalance");
      await this.opts.leases.delete(leaseKey(shardId), { previousSeq: lease.revision }).catch(() => {});
      return;
    }
    if (mine >= ceil) return;

    const held = await this.heldShards();
    // Start at an instance-specific offset so instances don't all contend for shard 0.
    const offset = hash(this.opts.instanceId) % this.opts.shardCount;
    for (let i = 0; i < this.opts.shardCount && this.owned.size < ceil; i++) {
      const shardId = (offset + i) % this.opts.shardCount;
      if (held.has(shardId) || this.owned.has(shardId)) continue;
      try {
        const revision = await this.opts.leases.create(leaseKey(shardId), this.opts.instanceId);
        this.owned.set(shardId, { revision, lastRenewedAt: Date.now() });
        this.opts.logger.info({ shardId }, "acquired shard lease");
        this.emit("acquired", shardId);
      } catch {
        // Someone else won the race for this shard; try the next one.
      }
    }
  }

  private drop(shardId: number, reason: ReleaseReason) {
    if (!this.owned.delete(shardId)) return;
    this.emit("released", shardId, reason);
  }

  /** Wait until the coordinator owns its fair share (used by tests). */
  async settle(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(100);
    }
    return predicate();
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
