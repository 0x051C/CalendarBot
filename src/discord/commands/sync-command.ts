import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { GuildRepository } from "../../db/repos/guilds";
import type { LinkView, SyncRepository } from "../../db/repos/sync";
import type { InspectResult, SyncService } from "../../sync/sync-service";

export const syncCommandDefinition = new SlashCommandBuilder()
  .setName("sync")
  .setDescription("Copy scheduled events from another server into this one")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("server")
      .setDescription("Keep all upcoming events of another server mirrored here")
      .addStringOption((o) =>
        o.setName("server").setDescription("Server ID (right-click the server → Copy Server ID)").setRequired(true).setMaxLength(25),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("event")
      .setDescription("Keep one event from another server mirrored here")
      .addStringOption((o) =>
        o.setName("link").setDescription("Event link (open the event → Copy Event Link)").setRequired(true).setMaxLength(200),
      ),
  )
  .addSubcommand((s) => s.setName("list").setDescription("Show what this server is syncing"))
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Stop a sync and delete the events it created here")
      .addStringOption((o) => o.setName("sync").setDescription("Which sync to remove").setRequired(true).setAutocomplete(true)),
  );

const SNOWFLAKE = /^\d{15,25}$/;
const EVENT_LINK = /discord(?:app)?\.com\/events\/(\d{15,25})\/(\d{15,25})/;

/** Accepts an event link (`https://discord.com/events/<guild>/<event>`). */
export function parseEventLink(input: string): { guildId: string; eventId: string } | null {
  const m = EVENT_LINK.exec(input.trim());
  return m ? { guildId: m[1]!, eventId: m[2]! } : null;
}

export function describeLink(l: Pick<LinkView, "sourceGuildName" | "sourceEventName" | "sourceEventId" | "sourceGuildId">): string {
  const server = l.sourceGuildName ?? `server ${l.sourceGuildId}`;
  if (!l.sourceEventId) return `All events from ${server}`;
  return `${l.sourceEventName ?? `Event ${l.sourceEventId}`} (from ${server})`;
}

const ephemeral = MessageFlags.Ephemeral;

export class SyncCommand {
  constructor(
    private readonly deps: { sync: SyncRepository; guilds: GuildRepository; syncService: SyncService; defaultLeadMinutes: number },
  ) {}

  async handle(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const sub = interaction.options.getSubcommand(true);
    if (sub === "list") return this.list(interaction);
    if (sub === "remove") return this.remove(interaction);

    let sourceGuildId: string;
    let sourceEventId: string | null = null;
    if (sub === "server") {
      sourceGuildId = interaction.options.getString("server", true).trim();
      if (!SNOWFLAKE.test(sourceGuildId)) {
        await interaction.reply({ content: "That doesn't look like a server ID. Right-click the server icon → **Copy Server ID**.", flags: ephemeral });
        return;
      }
    } else {
      const link = parseEventLink(interaction.options.getString("link", true));
      if (!link) {
        await interaction.reply({ content: "That doesn't look like an event link. Open the event → **Copy Event Link**.", flags: ephemeral });
        return;
      }
      ({ guildId: sourceGuildId, eventId: sourceEventId } = link);
    }
    return this.add(interaction, sourceGuildId, sourceEventId);
  }

  private async add(interaction: ChatInputCommandInteraction<"cached">, sourceGuildId: string, sourceEventId: string | null) {
    const { guild } = interaction;
    if (sourceGuildId === guild.id) {
      await interaction.reply({ content: "That's this server — pick a different one.", flags: ephemeral });
      return;
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ManageEvents)) {
      await interaction.reply({ content: "I need the **Manage Events** permission here to create the synced events.", flags: ephemeral });
      return;
    }

    // The source server may live on a shard owned by another instance: ask it over NATS.
    await interaction.deferReply({ flags: ephemeral });
    let source: InspectResult;
    try {
      source = await this.deps.syncService.inspect(sourceGuildId, interaction.user.id, sourceEventId);
    } catch {
      await interaction.editReply("I couldn't reach the part of the bot that serves that server. Please try again in a moment.");
      return;
    }
    const problem = !source.inGuild
      ? "I'm not in that server. Invite me there first, then run this again."
      : !source.isMember
        ? `You're not a member of **${source.guildName}**.`
        : !source.canManageEvents
          ? `You need **Manage Events** in **${source.guildName}** to sync its events.`
          : sourceEventId && !source.event
            ? `That event doesn't exist (any more) in **${source.guildName}**.`
            : null;
    if (problem || !source.inGuild) {
      await interaction.editReply(`❌ ${problem}`);
      return;
    }

    await this.deps.guilds.ensure(guild.id, guild.name, this.deps.defaultLeadMinutes);
    if (sourceEventId && (await this.deps.sync.hasWholeGuildLink(guild.id, sourceGuildId))) {
      await interaction.editReply(`Already syncing every event from **${source.guildName}**, including that one.`);
      return;
    }
    const link = await this.deps.sync.createLink({
      targetGuildId: guild.id,
      sourceGuildId,
      sourceEventId,
      createdBy: interaction.user.id,
    });
    if (!link) {
      await interaction.editReply("That sync already exists. See `/sync list`.");
      return;
    }

    const what = sourceEventId ? `**${source.event!.name}**` : "all upcoming events";
    try {
      const { created } = await this.deps.syncService.reconcile(guild.id);
      await interaction.editReply(
        `🔄 Now syncing ${what} from **${source.guildName}** (${created} event${created === 1 ? "" : "s"} created). ` +
          `Edits and cancellations there will follow automatically. Undo with \`/sync remove\`.`,
      );
    } catch {
      await interaction.editReply(
        `🔄 Sync with **${source.guildName}** saved, but copying the events failed for now — I'll keep retrying.`,
      );
    }
  }

  private async list(interaction: ChatInputCommandInteraction<"cached">) {
    const links = await this.deps.sync.linksForTarget(interaction.guildId);
    const embed = new EmbedBuilder()
      .setTitle("Event sync")
      .setColor(0x5865f2)
      .setDescription(
        links.length
          ? links
              .map((l) => `• ${describeLink(l)} — added by <@${l.createdBy}> <t:${Math.floor(l.createdAt.getTime() / 1000)}:R>`)
              .join("\n")
          : "This server isn't syncing events from anywhere. Use `/sync server` or `/sync event`.",
      );
    await interaction.reply({ embeds: [embed], flags: ephemeral });
  }

  private async remove(interaction: ChatInputCommandInteraction<"cached">) {
    const id = interaction.options.getString("sync", true);
    const link = /^[0-9a-f-]{36}$/i.test(id) ? await this.deps.sync.deleteLink(id, interaction.guildId) : undefined;
    if (!link) {
      await interaction.reply({ content: "I couldn't find that sync. Pick one from the list.", flags: ephemeral });
      return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const { removed } = await this.deps.syncService.reconcile(interaction.guildId).catch(() => ({ removed: 0 }));
    await interaction.editReply(`🛑 Sync removed. Deleted ${removed} mirrored event${removed === 1 ? "" : "s"} from this server.`);
  }

  async autocomplete(interaction: AutocompleteInteraction<"cached">): Promise<void> {
    const query = interaction.options.getFocused().toLowerCase();
    const links = await this.deps.sync.linksForTarget(interaction.guildId);
    await interaction.respond(
      links
        .map((l) => ({ name: describeLink(l).slice(0, 100), value: l.id }))
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice(0, 25),
    );
  }
}
