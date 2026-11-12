import { Client, GatewayIntentBits, Options, type ClientOptions } from "discord.js";
import type { Logger } from "../logger";

type ThrottlerFactory = NonNullable<NonNullable<ClientOptions["ws"]>["buildIdentifyThrottler"]>;

export interface ShardRunnerOptions {
  shardId: number;
  shardCount: number;
  token: string;
  buildIdentifyThrottler: ThrottlerFactory;
  /** Attach event handlers to the freshly created client. */
  wire: (client: Client, shardId: number) => void;
  logger: Logger;
  /** Unrecoverable errors (bad token, disallowed intents). */
  onFatal: (err: Error) => void;
}

const FATAL = /TokenInvalid|invalid token|disallowed intents|4004|4014/i;

/**
 * Owns the gateway session for exactly one shard. Each leased shard gets its
 * own Client so shards can move between instances independently.
 */
export class ShardRunner {
  readonly client: Client;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ShardRunnerOptions) {
    this.client = new Client({
      // Neither intent is privileged, so no Developer Portal toggles are needed.
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
      shards: [opts.shardId],
      shardCount: opts.shardCount,
      // Small footprint: the bot never reads messages, reactions or presences.
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        ReactionManager: 0,
        PresenceManager: 0,
        ThreadManager: 0,
        ThreadMemberManager: 0,
        VoiceStateManager: 0,
        GuildEmojiManager: 0,
        GuildStickerManager: 0,
        GuildInviteManager: 0,
        StageInstanceManager: 0,
      }),
      ws: { buildIdentifyThrottler: opts.buildIdentifyThrottler },
    });
    this.client.on("error", (err) => opts.logger.error({ err }, "discord client error"));
    this.client.on("warn", (msg) => opts.logger.warn(msg));
    opts.wire(this.client, opts.shardId);
  }

  get shardId() {
    return this.opts.shardId;
  }
  get ready() {
    return this.client.isReady();
  }
  get ping(): number | null {
    return this.client.isReady() && this.client.ws.ping >= 0 ? this.client.ws.ping : null;
  }

  async start(attempt = 1): Promise<void> {
    if (this.stopped) return;
    try {
      this.opts.logger.info({ attempt }, "starting gateway session");
      await this.client.login(this.opts.token);
    } catch (err) {
      const e = err as Error;
      if (FATAL.test(`${(e as { code?: unknown }).code ?? ""} ${e.message}`)) return this.opts.onFatal(e);
      const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      this.opts.logger.warn({ err: e, delay }, "gateway login failed; retrying");
      this.retry = setTimeout(() => void this.start(attempt + 1), delay);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client.destroy();
    this.opts.logger.info("gateway session closed");
  }
}
