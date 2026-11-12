import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
} from "discord.js";
import { ShardNotReadyError, type ShardRpc } from "../cluster/shard-rpc";
import type { SyncFeed, SyncNotice } from "../cluster/sync-feed";
import type { ScheduledEvent, SyncMirror } from "../db/schema";
import type { SyncRepository } from "../db/repos/sync";
import type { Logger } from "../logger";
import { shardForGuild } from "../util/shard";

export type InspectResult =
  | { inGuild: false }
  | {
      inGuild: true;
      guildName: string;
      isMember: boolean;
      canManageEvents: boolean;
      event: { id: string; name: string; startsAt: string } | null;
    };

export interface ReconcileSummary {
  created: number;
  updated: number;
  removed: number;
}

/** What SyncService needs from the shard layer (ShardManager implements it). */
export interface GuildLocator {
  shardCount: number;
  guild(guildId: string): Guild | null;
  ownedShardIds(): number[];
  readyShardIds(): number[];
}

const STALE_CLAIM_MS = 120_000;
const DISCORD_CHANNEL_URL = "https://discord.com/channels/";

/**
 * Mirrors scheduled events from source guilds into target guilds.
 *
 * - Commands ask the *source* guild's shard owner (NATS request/reply) whether
 *   the bot and the user are there.
 * - Source owners publish change notices to the *target* shard's durable
 *   JetStream consumer.
 * - Target owners reconcile: compare the desired mirrors (from Postgres) with
 *   the existing ones and create, update or delete Discord events to match.
 *   Reconciling is idempotent, so duplicate or late notices are harmless.
 */
export class SyncService {
  private readonly running = new Map<string, Promise<ReconcileSummary>>();
  private readonly rerun = new Set<string>();
  private periodic: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      sync: SyncRepository;
      feed: Pick<SyncFeed, "publish">;
      rpc: ShardRpc;
      shards: GuildLocator;
      /** The bot's own user id; events it created are mirrors and never sources. */
      botUserId: string;
      defaultDurationSeconds: number;
      logger: Logger;
      now?: () => Date;
    },
  ) {
    deps.rpc.handle("guild.inspect", (p) => this.inspectLocal(String(p.guildId), String(p.userId), p.eventId ? String(p.eventId) : null));
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // --- cross-shard queries ------------------------------------------------------

  /** Ask the shard that owns `guildId` (possibly another instance) about it. */
  inspect(guildId: string, userId: string, eventId: string | null = null): Promise<InspectResult> {
    return this.deps.rpc.request<InspectResult>(guildId, "guild.inspect", { guildId, userId, eventId });
  }

  /** Runs on the source guild's shard owner. */
  private async inspectLocal(guildId: string, userId: string, eventId: string | null): Promise<InspectResult> {
    const guild = this.deps.shards.guild(guildId);
    if (!guild) {
      const shard = shardForGuild(guildId, this.deps.shards.shardCount);
      if (this.deps.shards.ownedShardIds().includes(shard) && !this.deps.shards.readyShardIds().includes(shard)) {
        throw new ShardNotReadyError(shard);
      }
      return { inGuild: false };
    }
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    let event: { id: string; name: string; startsAt: string } | null = null;
    if (eventId) {
      const ev = await guild.scheduledEvents.fetch(eventId).catch(() => null);
      if (ev) event = { id: ev.id, name: ev.name, startsAt: new Date(ev.scheduledStartTimestamp ?? 0).toISOString() };
    }
    return {
      inGuild: true,
      guildName: guild.name,
      isMember: Boolean(member),
      canManageEvents: member?.permissions.has(PermissionFlagsBits.ManageEvents) ?? false,
      event,
    };
  }

  // --- change notification (runs on the source guild's owner) -------------------

  async notifySourceChanged(sourceGuildId: string, eventIds: readonly string[] | undefined, reason: string): Promise<void> {
    const targets = await this.deps.sync.targetsForSource(sourceGuildId, eventIds);
    await Promise.all(targets.map((targetGuildId) => this.deps.feed.publish({ targetGuildId, reason })));
  }

  async notifyTarget(targetGuildId: string, reason: string): Promise<void> {
    await this.deps.feed.publish({ targetGuildId, reason });
  }

  /** A Discord event was deleted. If it was a mirror deleted by hand, stop re-creating it. */
  async onEventDeleted(eventId: string): Promise<void> {
    const detached = await this.deps.sync.detachByTargetEvent(eventId);
    if (detached) this.deps.logger.info({ eventId, targetGuildId: detached.targetGuildId }, "mirror deleted by hand; detached");
  }

  // --- reconciliation (runs on the target guild's owner) -------------------------

  handleNotice = async (notice: SyncNotice): Promise<void> => {
    await this.reconcile(notice.targetGuildId);
  };

  /** Serialise per target; a request arriving mid-run schedules exactly one more run. */
  reconcile(targetGuildId: string): Promise<ReconcileSummary> {
    const inFlight = this.running.get(targetGuildId);
    if (inFlight) {
      this.rerun.add(targetGuildId);
      return inFlight;
    }
    const run = (async () => {
      let total: ReconcileSummary = { created: 0, updated: 0, removed: 0 };
      do {
        this.rerun.delete(targetGuildId);
        const s = await this.reconcileOnce(targetGuildId);
        total = { created: total.created + s.created, updated: total.updated + s.updated, removed: total.removed + s.removed };
      } while (this.rerun.has(targetGuildId));
      return total;
    })().finally(() => this.running.delete(targetGuildId));
    this.running.set(targetGuildId, run);
    return run;
  }

  async reconcileShard(shardId: number): Promise<void> {
    const targets = await this.deps.sync.targetsOnShards(this.deps.shards.shardCount, [shardId]);
    for (const t of targets) {
      await this.reconcile(t).catch((err) => this.deps.logger.warn({ err, targetGuildId: t }, "reconcile failed"));
    }
  }

  startPeriodic(intervalMs: number): void {
    this.periodic = setInterval(() => {
      for (const shardId of this.deps.shards.readyShardIds()) void this.reconcileShard(shardId);
    }, intervalMs);
  }

  stop(): void {
    if (this.periodic) clearInterval(this.periodic);
  }

  private async reconcileOnce(targetGuildId: string): Promise<ReconcileSummary> {
    const guild = this.deps.shards.guild(targetGuildId);
    if (!guild) throw new ShardNotReadyError(shardForGuild(targetGuildId, this.deps.shards.shardCount));

    const now = this.now();
    const summary: ReconcileSummary = { created: 0, updated: 0, removed: 0 };
    const covered = await this.deps.sync.coveredSourceEvents(targetGuildId, this.deps.botUserId);
    const mirrors = new Map((await this.deps.sync.mirrors(targetGuildId)).map((m) => [m.sourceEventId, m]));
    const log = this.deps.logger.child({ targetGuildId });

    for (const { event, sourceGuildName } of covered) {
      const mirror = mirrors.get(event.id);
      mirrors.delete(event.id);

      if (event.status === "cancelled") {
        if (mirror && mirror.status !== "detached") summary.removed += await this.removeMirror(guild, mirror);
        continue;
      }
      // Only upcoming events are copied or edited; Discord rejects past start times.
      if (event.status !== "scheduled" || event.startsAt <= now) continue;

      if (!mirror) {
        if (!(await this.deps.sync.claimMirror(targetGuildId, event.id))) continue; // another worker has it
        summary.created += await this.createMirror(guild, event, sourceGuildName, log);
      } else if (mirror.status === "active" && !mirror.targetEventId) {
        // A previous create never recorded its result: adopt the orphan or create again.
        if (!(await this.deps.sync.reclaimStale(targetGuildId, event.id, new Date(now.getTime() - STALE_CLAIM_MS)))) continue;
        const orphan = await this.deps.sync.findOrphanMirror(targetGuildId, event.url);
        if (orphan) await this.deps.sync.setMirrored(targetGuildId, event.id, orphan, -1);
        else summary.created += await this.createMirror(guild, event, sourceGuildName, log);
      } else if (mirror.status === "active" && mirror.sourceSequence !== event.sequence) {
        summary.updated += await this.updateMirror(guild, mirror, event, sourceGuildName, log);
      } else if (mirror.status === "removing") {
        summary.removed += await this.removeMirror(guild, mirror);
      }
    }

    // Mirrors no link covers any more (sync removed, or the source event is gone).
    for (const mirror of mirrors.values()) {
      if (mirror.status === "detached") await this.deps.sync.deleteMirror(targetGuildId, mirror.sourceEventId);
      else summary.removed += await this.removeMirror(guild, mirror);
    }

    if (summary.created || summary.updated || summary.removed) log.info(summary, "sync reconciled");
    return summary;
  }

  private payload(event: ScheduledEvent, sourceGuildName: string) {
    const suffix = `\n\n🔗 Synced from **${sourceGuildName}** · ${event.url}`;
    const location =
      event.location && !event.location.startsWith(DISCORD_CHANNEL_URL) ? event.location : `${sourceGuildName} (Discord)`;
    const end = event.endsAt ?? new Date(event.startsAt.getTime() + this.deps.defaultDurationSeconds * 1000);
    return {
      name: event.name.slice(0, 100),
      description: (event.description ?? "").slice(0, 1000 - suffix.length) + suffix,
      scheduledStartTime: event.startsAt,
      scheduledEndTime: end,
      entityMetadata: { location: location.slice(0, 100) },
    };
  }

  private async createMirror(guild: Guild, event: ScheduledEvent, sourceGuildName: string, log: Logger): Promise<number> {
    try {
      const created = await guild.scheduledEvents.create({
        ...this.payload(event, sourceGuildName),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        reason: `Synced from ${sourceGuildName} by CalendarBot`,
      });
      await this.deps.sync.setMirrored(guild.id, event.id, created.id, event.sequence);
      log.debug({ sourceEventId: event.id, mirrorId: created.id }, "mirror created");
      return 1;
    } catch (err) {
      await this.deps.sync.deleteMirror(guild.id, event.id); // release the claim so a retry can create it
      throw err;
    }
  }

  private async updateMirror(guild: Guild, mirror: SyncMirror, event: ScheduledEvent, sourceGuildName: string, log: Logger) {
    try {
      await guild.scheduledEvents.edit(mirror.targetEventId!, this.payload(event, sourceGuildName));
      await this.deps.sync.setMirrored(guild.id, event.id, mirror.targetEventId!, event.sequence);
      return 1;
    } catch (err) {
      if (code(err) === RESTJSONErrorCodes.UnknownGuildScheduledEvent) {
        await this.deps.sync.setStatus(guild.id, event.id, "detached"); // deleted by hand while we were away
        log.info({ sourceEventId: event.id }, "mirror missing in Discord; detached");
        return 0;
      }
      throw err;
    }
  }

  /** Mark → delete in Discord → forget, so a crash in between is retried, not orphaned. */
  private async removeMirror(guild: Guild, mirror: SyncMirror): Promise<number> {
    await this.deps.sync.setStatus(guild.id, mirror.sourceEventId, "removing");
    if (mirror.targetEventId) {
      try {
        await guild.scheduledEvents.delete(mirror.targetEventId);
      } catch (err) {
        if (code(err) !== RESTJSONErrorCodes.UnknownGuildScheduledEvent) throw err;
      }
    }
    await this.deps.sync.deleteMirror(guild.id, mirror.sourceEventId);
    return 1;
  }
}

const code = (err: unknown) => (err as { code?: number }).code;
