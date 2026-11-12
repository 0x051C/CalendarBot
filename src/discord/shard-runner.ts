import { Client, GatewayIntentBits, Options, type ClientOptions } from "discord.js";
import type { Logger } from "../logger";

type ThrottlerFactory = NonNullable<NonNullable<ClientOptions["ws"]>["buildIdentifyThrottler"]>;

export interface ShardRunnerOptions {
  shardId: number;
  shardCount: number;
  token: string;
  buildIdentifyThrottler: ThrottlerFactory;
  /** Attach event handlers to the freshly created client; `isActive` turns false once the shard is released. */
  wire: (client: Client, shardId: number, isActive: () => boolean) => void;
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
  private login: Promise<unknown> | null = null;

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
    opts.wire(this.client, opts.shardId, () => !this.stopped);
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
      this.login = this.client.login(this.opts.token);
      await this.login;
    } catch (err) {
      if (this.stopped) return; // aborted by stop()
      const e = err as Error;
      if (FATAL.test(`${(e as { code?: unknown }).code ?? ""} ${e.message}`)) return this.opts.onFatal(e);
      const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      this.opts.logger.warn({ err: e, delay }, "gateway login failed; retrying");
      this.retry = setTimeout(() => void this.start(attempt + 1), delay);
    }
  }

  /**
   * Close the gateway session.
   *
   * Careful: discord.js ignores destroy() after the first call, and a login
   * that is still between "fetch gateway info" and "connect shards" keeps
   * going after destroy(). Left alone, that would open a zombie session on a
   * shard this instance no longer owns. So if a login is in flight, close
   * whatever session it ends up opening directly on the underlying
   * @discordjs/ws manager.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client.destroy();
    if (this.login) {
      void this.login.catch(() => {}).finally(() => {
        const ws = (this.client.ws as unknown as { _ws?: { destroy(o: { code: number; reason: string }): Promise<void> } })._ws;
        void ws?.destroy({ code: 1000, reason: "shard released" }).catch(() => {});
      });
    }
    this.opts.logger.info("gateway session closed");
  }
}
