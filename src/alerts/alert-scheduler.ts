import type { AlertRepository } from "../db/repos/alerts";
import type { EventRepository } from "../db/repos/events";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { ShardManager } from "../discord/shard-manager";
import type { AlertService } from "./alert-service";

/**
 * Polls Postgres for alerts that are due on this instance's shards.
 *
 * Nothing lives in in-memory timers, so restarts, shard moves and lead-time
 * changes need no rescheduling: every tick re-derives "what is due" from the
 * database. Each alert is claimed in the database before it is sent, which
 * makes delivery exactly-once across the cluster.
 */
export class AlertScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      events: EventRepository;
      alerts: AlertRepository;
      alertService: AlertService;
      shards: ShardManager;
      instanceId: string;
      intervalMs: number;
      logger: Logger;
      metrics: Metrics;
      now?: () => Date;
      maxAttempts?: number;
      staleClaimMs?: number;
    },
  ) {}

  start(): void {
    const run = () => {
      if (this.current) return; // never overlap ticks
      this.current = this.tick()
        .catch((err) => this.deps.logger.error({ err }, "alert scheduler tick failed"))
        .finally(() => (this.current = null));
    };
    this.timer = setInterval(run, this.deps.intervalMs);
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  async tick(): Promise<void> {
    const { events, alerts, alertService, shards, logger, metrics } = this.deps;
    const shardIds = shards.readyShardIds();
    if (shardIds.length === 0) return;

    const now = this.deps.now?.() ?? new Date();
    const maxAttempts = this.deps.maxAttempts ?? 3;
    const staleClaimBefore = new Date(now.getTime() - (this.deps.staleClaimMs ?? 120_000));
    const due = await events.findDue({ now, shardCount: shards.shardCount, shardIds, staleClaimBefore, maxAttempts });

    for (const item of due) {
      const { event } = item;
      const guild = shards.guild(event.guildId);
      if (!guild) continue; // shard moved away or guild unavailable; whoever owns it will send

      const claim = await alerts.claim({
        eventId: event.id,
        startsAt: event.startsAt,
        instanceId: this.deps.instanceId,
        now,
        staleClaimBefore,
        maxAttempts,
      });
      if (!claim) continue; // another instance got there first

      const log = logger.child({ eventId: event.id, guildId: event.guildId, attempt: claim.attempts });
      try {
        const { channelId, messageId } = await alertService.deliver(item, guild);
        await alerts.markSent(event.id, event.startsAt, channelId, messageId, new Date());
        metrics.alerts.inc({ result: "sent" });
        log.info({ channelId, messageId }, "alert sent");
      } catch (err) {
        await alerts.markFailed(event.id, event.startsAt, (err as Error).message ?? String(err));
        metrics.alerts.inc({ result: "failed" });
        log.warn({ err }, "alert delivery failed");
      }
    }
  }
}
