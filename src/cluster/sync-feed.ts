import type { NatsConnection } from "@nats-io/transport-node";
import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import type { Logger } from "../logger";
import { ShardNotReadyError } from "./shard-rpc";
import { shardForGuild } from "../util/shard";

export interface SyncNotice {
  targetGuildId: string;
  reason: string;
}

/**
 * Durable, shard-partitioned change feed for event sync (JetStream).
 *
 * When a source guild's events change, its shard owner publishes a notice to
 * `<cluster>.sync.shard.<target shard>`. Each shard has its own durable
 * consumer, read by whichever instance leases that shard. If the lease moves,
 * the new owner resumes the same consumer, so notices published during a
 * failover are not lost. The stream is a work queue: acked notices are deleted.
 */
export class SyncFeed {
  private readonly consumers = new Map<number, ConsumerMessages>();

  private constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly opts: { cluster: string; shardCount: number; logger: Logger },
  ) {}

  static async open(nc: NatsConnection, opts: { cluster: string; shardCount: number; logger: Logger }) {
    const jsm = await jetstreamManager(nc);
    const feed = new SyncFeed(jetstream(nc), jsm, opts);
    const config = {
      name: feed.stream,
      subjects: [`${opts.cluster}.sync.shard.*`],
      retention: RetentionPolicy.Workqueue,
      max_age: nanos(24 * 3600 * 1000), // periodic reconcile covers anything older
    };
    try {
      await jsm.streams.add(config);
    } catch {
      await jsm.streams.update(feed.stream, config);
    }
    return feed;
  }

  get stream() {
    return `${this.opts.cluster}_sync`;
  }

  private subject(shardId: number) {
    return `${this.opts.cluster}.sync.shard.${shardId}`;
  }

  async publish(notice: SyncNotice): Promise<void> {
    const shardId = shardForGuild(notice.targetGuildId, this.opts.shardCount);
    await this.js.publish(this.subject(shardId), JSON.stringify(notice));
  }

  /** Begin consuming a shard's notices (on lease acquire). The handler must be idempotent. */
  async consume(shardId: number, handler: (notice: SyncNotice) => Promise<void>): Promise<void> {
    if (this.consumers.has(shardId)) return;
    const durable = `sync-shard-${shardId}`;
    await this.jsm.consumers
      .add(this.stream, {
        durable_name: durable,
        filter_subject: this.subject(shardId),
        ack_policy: AckPolicy.Explicit,
        ack_wait: nanos(60_000),
        max_deliver: 10,
      })
      .catch(() => {}); // already exists
    const consumer = await this.js.consumers.get(this.stream, durable);
    const messages = await consumer.consume({ max_messages: 16 });
    this.consumers.set(shardId, messages);

    void (async () => {
      for await (const m of messages) {
        try {
          await handler(m.json<SyncNotice>());
          m.ack();
        } catch (err) {
          const delay = Math.min(30_000, 1_000 * 2 ** (m.info.deliveryCount - 1));
          // A shard that was just handed over is briefly not ready: expected, so keep it quiet.
          const level = err instanceof ShardNotReadyError ? "debug" : "warn";
          this.opts.logger[level]({ err, shardId, delivery: m.info.deliveryCount, delay }, "sync notice failed; will redeliver");
          m.nak(delay);
        }
      }
    })();
  }

  /** Stop consuming (on lease release); unacked notices wait for the next owner. */
  async stopConsuming(shardId: number): Promise<void> {
    const messages = this.consumers.get(shardId);
    this.consumers.delete(shardId);
    await messages?.close().catch(() => {});
  }

  async stop(): Promise<void> {
    await Promise.all([...this.consumers.keys()].map((id) => this.stopConsuming(id)));
  }
}
