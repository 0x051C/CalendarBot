import { REST, Routes, type RESTGetAPIGatewayBotResult, type RESTGetAPIUserResult } from "discord.js";
import pkg from "../package.json" with { type: "json" };
import { AlertScheduler } from "./alerts/alert-scheduler";
import { AlertService } from "./alerts/alert-service";
import { CalendarExporter } from "./calendar/exporter";
import { NatsIdentifyThrottler } from "./cluster/identify-throttler";
import { agreeOnShardCount, connectNats, openBuckets } from "./cluster/nats";
import { ShardCoordinator } from "./cluster/shard-coordinator";
import { ShardRpc } from "./cluster/shard-rpc";
import { SyncFeed } from "./cluster/sync-feed";
import { startStatusService } from "./cluster/status-service";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";
import { AlertRepository } from "./db/repos/alerts";
import { EventRepository } from "./db/repos/events";
import { GuildRepository } from "./db/repos/guilds";
import { RsvpRepository } from "./db/repos/rsvps";
import { SyncRepository } from "./db/repos/sync";
import { SyncCommand } from "./discord/commands/sync-command";
import { SyncService } from "./sync/sync-service";
import { AlertCommand } from "./discord/commands/alert-command";
import { EventSync } from "./discord/event-sync";
import { ButtonHandler } from "./discord/interactions/buttons";
import { ShardManager } from "./discord/shard-manager";
import { ShardRunner } from "./discord/shard-runner";
import { wireClient } from "./discord/wire";
import { startHttpServer } from "./http/server";
import { createLogger } from "./logger";
import { createMetrics } from "./metrics";

const SHUTDOWN_TIMEOUT_MS = 20_000;
const SYNC_RECONCILE_INTERVAL_MS = 5 * 60_000;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.instanceId);
  const metrics = createMetrics();
  logger.info({ version: pkg.version, cluster: config.clusterName }, "starting calendarbot");

  // --- Infrastructure -------------------------------------------------------
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const database = connectDatabase(config.databaseUrl, config.instanceId);
  await database.migrate(config.migrationsDir);
  logger.info("database migrations applied");

  const nc = await connectNats(config.natsUrl, config.instanceId, logger);
  const buckets = await openBuckets(nc, config.clusterName, config.leaseTtlMs);
  const shardCount = await agreeOnShardCount(
    buckets.config,
    async () => (config.shardCount === "auto" ? recommendedShards(rest) : config.shardCount),
    logger,
  );
  if (config.shardCount !== "auto" && config.shardCount !== shardCount) {
    logger.warn(
      { configured: config.shardCount, cluster: shardCount },
      `SHARD_COUNT differs from the cluster's; using ${shardCount}. To reshard: stop all instances, run ` +
        `\`nats kv del ${config.clusterName}_config shard_count\`, then start them again.`,
    );
  }

  // --- Domain services ------------------------------------------------------
  const { db } = database;
  const guilds = new GuildRepository(db);
  const events = new EventRepository(db);
  const alerts = new AlertRepository(db);
  const rsvps = new RsvpRepository(db);
  const syncRepo = new SyncRepository(db);
  const botUser = (await rest.get(Routes.user())) as RESTGetAPIUserResult;

  const exporter = new CalendarExporter({
    guilds,
    events,
    dir: config.icalPath,
    defaultDurationSeconds: config.icalEventDurationSeconds,
    logger,
  });
  const alertService = new AlertService({ alerts, rsvps, logger });
  const eventSync = new EventSync({
    guilds,
    events,
    alertService,
    exporter,
    defaultLeadMinutes: config.defaultAlertLeadMinutes,
    logger,
  });
  const alertCommand = new AlertCommand({ guilds, events, defaultLeadMinutes: config.defaultAlertLeadMinutes });
  const buttons = new ButtonHandler({ events, rsvps, alertService, eventSync });

  // Cross-shard plumbing for /sync: shard-addressed RPC + a durable per-shard work queue.
  const shardRpc = new ShardRpc({ nc, cluster: config.clusterName, shardCount, logger });
  const syncFeed = await SyncFeed.open(nc, { cluster: config.clusterName, shardCount, logger });

  // --- Discord shards -------------------------------------------------------
  let shutdown: (reason: string, code?: number) => Promise<void> = async () => {};
  const shards = new ShardManager({
    shardCount,
    logger,
    createRunner: (shardId) =>
      new ShardRunner({
        shardId,
        shardCount,
        token: config.discordToken,
        logger: logger.child({ shard: shardId }),
        buildIdentifyThrottler: async (manager) => {
          const info = await manager.fetchGatewayInformation();
          return new NatsIdentifyThrottler(buckets.identify, info.session_start_limit.max_concurrency, config.instanceId);
        },
        wire: (client, id, isActive) =>
          wireClient(
            client,
            id,
            {
            eventSync,
            guilds,
            alertCommand,
            syncCommand,
            buttons,
            onShardSynced: (id) => syncService.reconcileShard(id),
            registerCommands: config.registerCommands,
            logger,
            metrics,
            },
            isActive,
          ),
        onFatal: (err) => {
          logger.fatal({ err }, "unrecoverable Discord error (check DISCORD_TOKEN)");
          void shutdown("fatal discord error", 1);
        },
      }),
  });

  const syncService = new SyncService({
    sync: syncRepo,
    feed: syncFeed,
    rpc: shardRpc,
    shards,
    botUserId: botUser.id,
    defaultDurationSeconds: config.icalEventDurationSeconds,
    logger,
  });
  eventSync.setHooks({
    sourceChanged: (guildId, eventIds, reason) => syncService.notifySourceChanged(guildId, eventIds, reason),
    eventDeleted: (eventId) => syncService.onEventDeleted(eventId),
  });
  const syncCommand = new SyncCommand({
    sync: syncRepo,
    guilds,
    syncService,
    defaultLeadMinutes: config.defaultAlertLeadMinutes,
    logger,
  });

  const coordinator = new ShardCoordinator({
    leases: buckets.leases,
    instances: buckets.instances,
    instanceId: config.instanceId,
    shardCount,
    leaseTtlMs: config.leaseTtlMs,
    logger,
  });
  coordinator.on("acquired", (id) => {
    metrics.leaseEvents.inc({ event: "acquired" });
    shardRpc.serve(id);
    void syncFeed
      .consume(id, syncService.handleNotice)
      .catch((err) => logger.error({ err, shardId: id }, "failed to start sync consumer"));
    void shards.start(id);
  });
  coordinator.on("released", (id, reason) => {
    metrics.leaseEvents.inc({ event: reason });
    shardRpc.unserve(id);
    void syncFeed.stopConsuming(id);
    void shards.stop(id);
  });

  const scheduler = new AlertScheduler({
    events,
    alerts,
    alertService,
    shards,
    instanceId: config.instanceId,
    intervalMs: config.schedulerIntervalMs,
    logger,
    metrics,
  });

  // --- Observability --------------------------------------------------------
  const status = await startStatusService({
    nc,
    cluster: config.clusterName,
    version: pkg.version,
    buckets,
    local: () => ({ instanceId: config.instanceId, shards: shards.status() }),
  });
  const http =
    config.httpPort > 0
      ? await startHttpServer({
          port: config.httpPort,
          metrics,
          logger,
          checks: {
            nats: () => !nc.isClosed() && !nc.isDraining(),
            database: () => database.ping(),
            shards: () => ({ owned: shards.ownedShardIds(), ready: shards.readyShardIds() }),
          },
          beforeScrape: () => {
            metrics.shardsOwned.set(coordinator.ownedShards().length);
            metrics.clusterInstances.set(coordinator.liveInstances);
            metrics.shardReady.reset();
            metrics.gatewayPing.reset();
            for (const s of shards.status()) {
              metrics.shardReady.set({ shard: String(s.id) }, s.ready ? 1 : 0);
              if (s.ping !== null) metrics.gatewayPing.set({ shard: String(s.id) }, s.ping);
            }
          },
        })
      : null;

  coordinator.start();
  scheduler.start();
  syncService.startPeriodic(SYNC_RECONCILE_INTERVAL_MS);
  logger.info({ shardCount, leaseTtlMs: config.leaseTtlMs }, "joined cluster");

  // --- Graceful shutdown ----------------------------------------------------
  let stopping = false;
  shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, "shutting down");
    const force = setTimeout(() => {
      logger.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await scheduler.stop();
      syncService.stop();
      shardRpc.stop();
      await syncFeed.stop();
      // Close gateway sessions before handing leases back, so two instances
      // never serve the same shard at once.
      await shards.stopAll();
      await coordinator.stop();
      await exporter.flush();
      await status.stop();
      await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
      await nc.drain();
      await database.close();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      code = code || 1;
    }
    logger.info("bye");
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled promise rejection"));
}

async function recommendedShards(rest: REST): Promise<number> {
  const info = (await rest.get(Routes.gatewayBot())) as RESTGetAPIGatewayBotResult;
  return info.shards;
}

main().catch((err) => {
  // The logger may not exist yet (e.g. invalid config), so fall back to stderr.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
