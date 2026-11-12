import { Events, MessageFlags, type Client, type Guild, type Interaction } from "discord.js";
import type { GuildRepository } from "../db/repos/guilds";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import { alertCommandDefinition, type AlertCommand } from "./commands/alert-command";
import { syncCommandDefinition, type SyncCommand } from "./commands/sync-command";
import { parseCustomId } from "./custom-ids";
import type { EventSync } from "./event-sync";
import type { ButtonHandler } from "./interactions/buttons";

const RESYNC_AFTER_MS = 30_000;

export interface WireDeps {
  eventSync: EventSync;
  guilds: GuildRepository;
  alertCommand: AlertCommand;
  syncCommand: SyncCommand;
  buttons: ButtonHandler;
  /** Called once a shard has reconciled all its guilds (catch up on event sync). */
  onShardSynced?: (shardId: number) => Promise<void>;
  registerCommands: boolean;
  logger: Logger;
  metrics: Metrics;
}

/** Attach all gateway event handlers for one shard's client. */
export function wireClient(client: Client, shardId: number, deps: WireDeps, isActive: () => boolean = () => true): void {
  const log = deps.logger.child({ shard: shardId });
  const cleanedLegacyCommands = new Set<string>();

  // GuildAvailable fires for every guild on connect *and* ClientReady follows,
  // so coalesce: one sync at a time per guild, skipped if one just finished.
  const recentSync = new Map<string, Promise<void> | number>();
  const sync = (guild: Guild, opts: { force?: boolean } = {}): Promise<void> => {
    const prev = recentSync.get(guild.id);
    if (prev instanceof Promise) return prev;
    if (!opts.force && typeof prev === "number" && Date.now() - prev < RESYNC_AFTER_MS) return Promise.resolve();
    const run = syncGuild(guild).finally(() => recentSync.set(guild.id, Date.now()));
    recentSync.set(guild.id, run);
    return run;
  };
  const syncGuild = async (guild: Guild) => {
    if (!isActive()) return; // shard was released while this was queued
    try {
      await deps.eventSync.syncGuild(guild);
      if (deps.registerCommands && !cleanedLegacyCommands.has(guild.id)) {
        cleanedLegacyCommands.add(guild.id);
        // v0 registered /alert per guild; those would show up next to the global command.
        const legacy = await guild.commands.fetch();
        if (legacy.size > 0) {
          await guild.commands.set([]);
          log.info({ guildId: guild.id, removed: legacy.size }, "removed legacy guild commands");
        }
      }
    } catch (err) {
      log.error({ err, guildId: guild.id }, "guild sync failed");
    }
  };
  const safe = <A extends unknown[]>(name: string, fn: (...args: A) => Promise<unknown>) =>
    (...args: A) => {
      if (!isActive()) return;
      void fn(...args).catch((err) => log.error({ err }, `${name} handler failed`));
    };

  client.on(Events.ClientReady, async (c) => {
    if (!isActive()) return;
    log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "shard ready");
    if (shardId === 0 && deps.registerCommands) {
      // Global commands are cluster-wide; the shard-0 owner keeps them current.
      await c.application.commands
        .set([alertCommandDefinition.toJSON(), syncCommandDefinition.toJSON()])
        .then(() => log.info("registered global slash commands"))
        .catch((err) => log.error({ err }, "failed to register slash commands"));
    }
    for (const guild of c.guilds.cache.values()) await sync(guild);
    await deps.onShardSynced?.(shardId).catch((err) => log.error({ err }, "post-sync hook failed"));
  });

  client.on(Events.GuildCreate, (g) => void sync(g, { force: true })); // bot added to a server
  client.on(Events.GuildAvailable, (g) => void sync(g)); // initial connect, or back after an outage
  client.on(
    Events.GuildDelete,
    safe("guildDelete", async (g) => {
      if (!g.available) return; // outage, not removal
      await deps.guilds.delete(g.id);
      log.info({ guildId: g.id }, "removed from guild; deleted its data");
    }),
  );
  client.on(Events.GuildUpdate, safe("guildUpdate", (_old, g) => deps.eventSync.renameGuild(g)));

  client.on(Events.GuildScheduledEventCreate, safe("eventCreate", (e) => deps.eventSync.upsert(e)));
  client.on(Events.GuildScheduledEventUpdate, safe("eventUpdate", async (_old, e) => deps.eventSync.upsert(e)));
  client.on(Events.GuildScheduledEventDelete, safe("eventDelete", (e) => deps.eventSync.remove(e)));
  const attendance = safe("eventUser", async (e: { id: string; guild: Guild | null }) =>
    e.guild ? deps.eventSync.refreshAttendance(e.id, e.guild) : undefined,
  );
  client.on(Events.GuildScheduledEventUserAdd, (e) => attendance(e));
  client.on(Events.GuildScheduledEventUserRemove, (e) => attendance(e));

  client.on(Events.InteractionCreate, (i) => {
    if (isActive()) void handleInteraction(i, deps, log);
  });
}

async function handleInteraction(interaction: Interaction, deps: WireDeps, log: Logger) {
  if (!interaction.inCachedGuild()) return;
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "sync") await deps.syncCommand.autocomplete(interaction).catch(() => {});
    return;
  }
  const kind = interaction.isChatInputCommand() ? "command" : interaction.isButton() ? "button" : null;
  if (!kind) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "alert") {
      await deps.alertCommand.handle(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === "sync") {
      await deps.syncCommand.handle(interaction);
    } else if (interaction.isButton()) {
      const action = parseCustomId(interaction.customId);
      if (!action) return;
      await deps.buttons.handle(interaction, action);
    }
    deps.metrics.interactions.inc({ kind, outcome: "ok" });
  } catch (err) {
    deps.metrics.interactions.inc({ kind, outcome: "error" });
    log.error({ err, guildId: interaction.guildId }, "interaction failed");
    const reply = { content: "Something went wrong handling that. Please try again.", flags: MessageFlags.Ephemeral } as const;
    if (!interaction.isRepliable()) return;
    await (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
}
