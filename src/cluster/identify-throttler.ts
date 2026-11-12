import type { KV } from "@nats-io/kv";

/** Structural copy of @discordjs/ws IIdentifyThrottler. */
export interface IdentifyThrottler {
  waitForIdentify(shardId: number, signal: AbortSignal): Promise<void>;
}

/**
 * Cluster-wide gateway IDENTIFY rate limit.
 *
 * Discord allows `max_concurrency` identifies per 5 seconds, per bot, across
 * every process. discord.js only enforces that inside one process, so with
 * several instances we take a slot in a NATS KV bucket whose TTL is the
 * rate-limit window: `create(bucket.<shardId % max_concurrency>)` succeeds for
 * one shard at a time, and the key expiring frees the slot.
 */
export class NatsIdentifyThrottler implements IdentifyThrottler {
  constructor(
    private readonly kv: KV,
    private readonly maxConcurrency: number,
    private readonly holder: string,
    private readonly pollMs = 250,
  ) {}

  async waitForIdentify(shardId: number, signal: AbortSignal): Promise<void> {
    const key = `bucket.${shardId % Math.max(1, this.maxConcurrency)}`;
    while (true) {
      signal.throwIfAborted();
      try {
        await this.kv.create(key, `${this.holder}:${shardId}`);
        return;
      } catch {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.pollMs);
          signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
        });
      }
    }
  }
}
