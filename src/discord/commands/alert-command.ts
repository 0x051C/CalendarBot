import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { EventRepository } from "../../db/repos/events";
import type { GuildRepository } from "../../db/repos/guilds";
import { resolveAlertChannel } from "../channel-resolver";

export const MAX_LEAD_MINUTES = 10_080; // one week

export const alertCommandDefinition = new SlashCommandBuilder()
  .setName("alert")
  .setDescription("Configure event alerts for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("lead-time")
      .setDescription("How long before an event starts to post its alert")
      .addIntegerOption((o) =>
        o
          .setName("minutes")
          .setDescription(`Minutes before the start (0–${MAX_LEAD_MINUTES})`)
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(MAX_LEAD_MINUTES),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("channel")
      .setDescription("Always post alerts in this channel")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("A text or announcement channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((s) => s.setName("channel-reset").setDescription("Choose the alert channel automatically again"))
  .addSubcommand((s) => s.setName("settings").setDescription("Show alert settings and upcoming alerts"));

const SOURCE_LABEL = { override: "set with /alert channel", system: "server's system channel", fallback: "first channel I can post in" };
const ephemeral = MessageFlags.Ephemeral;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export class AlertCommand {
  constructor(
    private readonly deps: { guilds: GuildRepository; events: EventRepository; defaultLeadMinutes: number },
  ) {}

  async handle(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const { guild } = interaction;
    await this.deps.guilds.ensure(guild.id, guild.name, this.deps.defaultLeadMinutes);

    switch (interaction.options.getSubcommand(true)) {
      case "lead-time": {
        const minutes = interaction.options.getInteger("minutes", true);
        await this.deps.guilds.setLeadMinutes(guild.id, minutes);
        await interaction.reply({
          content: `⏰ Alerts will be posted **${formatMinutes(minutes)}** before events start. Upcoming alerts are rescheduled automatically.`,
          flags: ephemeral,
        });
        return;
      }

      case "channel": {
        const channel = interaction.options.getChannel("channel", true, [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ]) as TextChannel | NewsChannel;
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const perms = channel.permissionsFor(me);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          await interaction.reply({
            content: `❌ I can't post in ${channel}. Give me **View Channel** and **Send Messages** there, then try again.`,
            flags: ephemeral,
          });
          return;
        }
        await this.deps.guilds.setAlertChannel(guild.id, channel.id);
        const embedNote = perms.has(PermissionFlagsBits.EmbedLinks)
          ? ""
          : "\n⚠️ I'm missing **Embed Links** there, so alerts will be plain text.";
        await interaction.reply({ content: `📣 Alerts will be posted in ${channel}.${embedNote}`, flags: ephemeral });
        return;
      }

      case "channel-reset": {
        await this.deps.guilds.setAlertChannel(guild.id, null);
        const { choice } = await resolveAlertChannel(guild, null);
        await interaction.reply({
          content: choice
            ? `↩️ Channel override removed. Alerts will go to <#${choice.channelId}> (${SOURCE_LABEL[choice.source]}).`
            : "↩️ Channel override removed, but there's no channel I can post in yet.",
          flags: ephemeral,
        });
        return;
      }

      case "settings": {
        const settings = (await this.deps.guilds.get(guild.id))!;
        const { choice, overrideProblem } = await resolveAlertChannel(guild, settings.alertChannelId);
        const upcoming = await this.deps.events.upcoming(guild.id, new Date(), 5);
        const lead = settings.alertLeadMinutes * 60_000;

        const channelLine = choice
          ? `<#${choice.channelId}> (${SOURCE_LABEL[choice.source]})`
          : "⚠️ no channel I can post in";
        const problem =
          overrideProblem === "missing"
            ? "\n⚠️ The configured channel no longer exists."
            : overrideProblem === "no-permission"
              ? `\n⚠️ I can't post in <#${settings.alertChannelId}>.`
              : "";

        const embed = new EmbedBuilder()
          .setTitle("Alert settings")
          .setColor(0x5865f2)
          .addFields(
            { name: "Lead time", value: formatMinutes(settings.alertLeadMinutes), inline: true },
            { name: "Channel", value: channelLine + problem, inline: true },
            {
              name: "Upcoming alerts",
              value:
                upcoming
                  .map((e) => `• **${e.name}** — alert <t:${unix(new Date(e.startsAt.getTime() - lead))}:R>`)
                  .join("\n") || "No upcoming events.",
            },
          );
        await interaction.reply({ embeds: [embed], flags: ephemeral });
        return;
      }
    }
  }
}

export function formatMinutes(m: number): string {
  if (m === 0) return "at the start time";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  return [d && `${d}d`, h && `${h}h`, min && `${min}m`].filter(Boolean).join(" ");
}
