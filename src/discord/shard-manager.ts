import type { Client, Guild } from "discord.js";
import type { Logger } from "../logger";
import { shardForGuild } from "../util/shard";
import type { ShardRunner } from "./shard-runner";

export interface ShardStatus {
  id: number;
  ready: boolean;
  ping: number | null;
  guilds: number;
}

/** Starts and stops one ShardRunner per shard this instance currently leases. */
export class ShardManager {
  private readonly runners = new Map<number, ShardRunner>();

  constructor(
    private readonly opts: {
      shardCount: number;
      createRunner: (shardId: number) => ShardRunner;
      logger: Logger;
    },
  ) {}

  get shardCount() {
    return this.opts.shardCount;
  }

  async start(shardId: number): Promise<void> {
    if (this.runners.has(shardId)) return;
    const runner = this.opts.createRunner(shardId);
    this.runners.set(shardId, runner);
    await runner.start();
  }

  async stop(shardId: number): Promise<void> {
    const runner = this.runners.get(shardId);
    if (!runner) return;
    this.runners.delete(shardId);
    await runner.stop().catch((err) => this.opts.logger.warn({ err, shardId }, "error stopping shard"));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }

  ownedShardIds(): number[] {
    return [...this.runners.keys()].sort((a, b) => a - b);
  }

  readyShardIds(): number[] {
    return [...this.runners.values()].filter((r) => r.ready).map((r) => r.shardId).sort((a, b) => a - b);
  }

  /** The ready client serving this guild, if this instance owns its shard. */
  clientForGuild(guildId: string): Client<true> | null {
    const runner = this.runners.get(shardForGuild(guildId, this.opts.shardCount));
    return runner?.client.isReady() ? runner.client : null;
  }

  guild(guildId: string): Guild | null {
    return this.clientForGuild(guildId)?.guilds.cache.get(guildId) ?? null;
  }

  status(): ShardStatus[] {
    return [...this.runners.values()]
      .map((r) => ({ id: r.shardId, ready: r.ready, ping: r.ping, guilds: r.client.guilds.cache.size }))
      .sort((a, b) => a.id - b.id);
  }
}
