import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import type { Logger } from "../logger";
import { shardForGuild } from "../util/shard";

export type RpcHandler = (payload: Record<string, unknown>) => Promise<unknown>;

interface RpcRequest {
  op: string;
  payload: Record<string, unknown>;
}
type RpcResponse = { ok: true; result: unknown } | { ok: false; error: string; retryable?: boolean };

export class ShardRpcError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Thrown by handlers when the shard is owned here but its gateway isn't ready yet. */
export class ShardNotReadyError extends ShardRpcError {
  constructor(shardId: number) {
    super(`shard ${shardId} is not ready`, true);
  }
}

/**
 * Request/reply addressed to a *shard*, not an instance.
 *
 * Whoever currently leases shard N subscribes to `<cluster>.shard.N.rpc`
 * (and unsubscribes when the lease moves), so a caller only needs a guild id:
 * `request(guildId, "guild.inspect", …)` reaches the instance that holds that
 * guild's gateway session, wherever it runs. Calls for shards owned locally
 * skip the network hop.
 */
export class ShardRpc {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly subs = new Map<number, Subscription>();

  constructor(
    private readonly opts: {
      nc: NatsConnection;
      cluster: string;
      shardCount: number;
      logger: Logger;
      timeoutMs?: number;
    },
  ) {}

  subject(shardId: number) {
    return `${this.opts.cluster}.shard.${shardId}.rpc`;
  }

  handle(op: string, handler: RpcHandler): void {
    this.handlers.set(op, handler);
  }

  /** Start answering for a shard (called when its lease is acquired). */
  serve(shardId: number): void {
    if (this.subs.has(shardId)) return;
    const sub = this.opts.nc.subscribe(this.subject(shardId), {
      callback: (err, msg) => {
        if (err) return;
        void (async () => {
          let res: RpcResponse;
          try {
            const req = msg.json<RpcRequest>();
            res = { ok: true, result: await this.dispatch(req.op, req.payload) };
          } catch (e) {
            res = { ok: false, error: (e as Error).message, retryable: e instanceof ShardRpcError && e.retryable };
          }
          msg.respond(JSON.stringify(res));
        })();
      },
    });
    this.subs.set(shardId, sub);
  }

  unserve(shardId: number): void {
    this.subs.get(shardId)?.unsubscribe();
    this.subs.delete(shardId);
  }

  serving(shardId: number): boolean {
    return this.subs.has(shardId);
  }

  async request<T>(guildId: string, op: string, payload: Record<string, unknown>, attempts = 3): Promise<T> {
    const shardId = shardForGuild(guildId, this.opts.shardCount);
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.subs.has(shardId)) return (await this.dispatch(op, payload)) as T;
        const msg = await this.opts.nc.request(this.subject(shardId), JSON.stringify({ op, payload }), {
          timeout: this.opts.timeoutMs ?? 5_000,
        });
        const res = msg.json<RpcResponse>();
        if (res.ok) return res.result as T;
        throw new ShardRpcError(res.error, res.retryable);
      } catch (err) {
        // "no responders" means the shard is between owners (failover in progress).
        const retryable =
          (err instanceof ShardRpcError && err.retryable) || /no responders|timeout/i.test((err as Error).message);
        if (!retryable || attempt >= attempts) throw err;
        this.opts.logger.debug({ err, shardId, op, attempt }, "shard rpc retry");
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  private async dispatch(op: string, payload: Record<string, unknown>) {
    const handler = this.handlers.get(op);
    if (!handler) throw new ShardRpcError(`unknown op ${op}`);
    return handler(payload);
  }

  stop(): void {
    for (const id of [...this.subs.keys()]) this.unserve(id);
  }
}
