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
import type { Logger } from "../../logger";
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
// "Copy Event Link": https://discord.com/events/<guild>/<event>[/<occurrence>] (also ptb./canary./discordapp.com)
const EVENT_LINK = /discord(?:app)?\.com\/events\/(\d{15,25})\/(\d{15,25})/;
// "Share" button: https://discord.gg/<code>?event=<event> or https://discord.com/invite/<code>?event=<event>
const INVITE_LINK = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,64})\/?\?(?:[^#\s]*&)?event=(\d{15,25})/;

export type EventReference =
  | { kind: "event"; guildId: string; eventId: string }
  | { kind: "invite"; code: string; eventId: string };

/** Parse either kind of event link Discord produces. */
export function parseEventReference(input: string): EventReference | null {
  const text = input.trim();
  const direct = EVENT_LINK.exec(text);
  if (direct) return { kind: "event", guildId: direct[1]!, eventId: direct[2]! };
  const invite = INVITE_LINK.exec(text);
  if (invite) return { kind: "invite", code: invite[1]!, eventId: invite[2]! };
  return null;
}

const LINK_HELP =
  "Use either the event's **Share** link (`discord.gg/…?event=…`) or, with Developer Mode on, " +
  "right-click the event → **Copy Event Link** (`discord.com/events/…`).";

export function describeLink(l: Pick<LinkView, "sourceGuildName" | "sourceEventName" | "sourceEventId" | "sourceGuildId">): string {
  const server = l.sourceGuildName ?? `server ${l.sourceGuildId}`;
  if (!l.sourceEventId) return `All events from ${server}`;
  return `${l.sourceEventName ?? `Event ${l.sourceEventId}`} (from ${server})`;
}

const ephemeral = MessageFlags.Ephemeral;

export class SyncCommand {
  constructor(
    private readonly deps: {
      sync: SyncRepository;
      guilds: GuildRepository;
      syncService: SyncService;
      defaultLeadMinutes: number;
      logger: Logger;
    },
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
      const input = interaction.options.getString("link", true);
      const ref = parseEventReference(input);
      if (!ref) {
        this.deps.logger.info({ guildId: interaction.guildId, input: input.slice(0, 200) }, "rejected /sync event link");
        await interaction.reply({ content: `That doesn't look like an event link. ${LINK_HELP}`, flags: ephemeral });
        return;
      }
      sourceEventId = ref.eventId;
      if (ref.kind === "event") {
        sourceGuildId = ref.guildId;
      } else {
        // Invite links don't contain the server id; Discord resolves it (and checks the event exists).
        await interaction.deferReply({ flags: ephemeral });
        const invite = await interaction.client.fetchInvite(ref.code, { guildScheduledEventId: ref.eventId }).catch(() => null);
        if (!invite?.guild) {
          await interaction.editReply("❌ That invite link is invalid or has expired. Create a new one from the event's **Share** button.");
          return;
        }
        sourceGuildId = invite.guild.id;
      }
    }
    return this.add(interaction, sourceGuildId, sourceEventId);
  }

  private async add(interaction: ChatInputCommandInteraction<"cached">, sourceGuildId: string, sourceEventId: string | null) {
    const { guild } = interaction;
    if (!interaction.deferred) await interaction.deferReply({ flags: ephemeral });
    if (sourceGuildId === guild.id) {
      await interaction.editReply("That's this server. Pick a different one.");
      return;
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ManageEvents)) {
      await interaction.editReply("I need the **Manage Events** permission here to create the synced events.");
      return;
    }

    // The source server may live on a shard owned by another instance: ask it over NATS.
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
