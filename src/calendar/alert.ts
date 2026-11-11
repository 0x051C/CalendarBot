import { bot_client } from "../discordjs_client_config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";

export class GuildScheduledEventAlert {
  id: string;
  guild_id: string;
  start: Date;
  leadTime: Date;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: string,
    guild_id: string,
    start: Date,
    reminderTime: Date,
  ) {
    this.id = id;
    this.guild_id = guild_id;
    this.start = start;
    this.leadTime = reminderTime;

    const alertDelay = reminderTime.getTime() - Date.now();

    if (!Number.isFinite(alertDelay)) {
      console.error(
        `Invalid reminder time (${reminderTime}) during timeout setup.`,
      );
      return;
    }

    if (this.start.getTime() <= Date.now() || alertDelay <= 0) {
      return;
    }

    let delay = alertDelay;

    // Special handling for this guild.
    const guild = bot_client.guilds.cache.get(guild_id);
    if (guild?.id === "1030185189265133677" || guild?.name === "Yutzin's Hive") {
      delay = 1000;
    }

    this.timeoutId = this.longTimeout(async () => {
      try {
        const guild = await bot_client.guilds.fetch(this.guild_id);

        const event = guild.scheduledEvents.cache.get(this.id);

        if (!event) {
          console.error(
            `Scheduled event ${this.id} no longer exists in guild ${guild.name}.`,
          );
          return;
        }

        const botUser = bot_client.user;

        if (!botUser) {
          console.error("Bot user is unavailable.");
          return;
        }

        const botMember = await guild.members.fetch(botUser.id);

        const subscribers = await event.fetchSubscribers();

        console.log(`Subscribers for ${event.name}:`);
        subscribers.forEach((subscriber) => {
          console.log(subscriber.user.tag);
        });

        const startTimestamp = Math.floor(this.start.getTime() / 1000);

        const attendeeString = subscribers
          .map((subscriber) => `<@${subscriber.user.id}>`)
          .join(" ");

        const msg =
          `${event.url}\n` +
          `${event.name} scheduled to start <t:${startTimestamp}:R>, ` +
          `${attendeeString} please join!\n`;

        const attendeeStatusEmbed = new EmbedBuilder()
          .setTitle(`📅 ${event.name}`)
          .setDescription(`Event starts <t:${startTimestamp}:R>`)
          .addFields({
            name: "👥 Attendees",
            value:
              subscribers.map((subscriber) => subscriber.user.tag).join("\n") ||
              "None",
            inline: true,
          })
          .setColor(0x5865f2)
          .setTimestamp();

        const buttons: ButtonBuilder[] = [];

        const showButton = new ButtonBuilder()
          .setLabel("Will join")
          .setStyle(ButtonStyle.Success)
          .setCustomId(`will_show${event.id}`);

        buttons.push(showButton);

        const noshowButton = new ButtonBuilder()
          .setLabel("Can't join")
          .setStyle(ButtonStyle.Danger)
          .setCustomId(`no_show${event.id}`);

        buttons.push(noshowButton);

        if (event.channel) {
          const joinChannelButton = new ButtonBuilder()
            .setLabel("Event link")
            .setStyle(ButtonStyle.Link)
            .setURL(event.channel.url);

          buttons.push(joinChannelButton);
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          buttons,
        );

        // Find the first text-based channel where the bot can send messages.
        const channels = await guild.channels.fetch();

        for (const channel of channels.values()) {
          if (!channel || !channel.isTextBased()) {
            continue;
          }

          const permissions = channel.permissionsFor(botMember);

          if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
            continue;
          }

          const embedPermission = permissions.has(
            PermissionFlagsBits.EmbedLinks,
          );

          console.log(`Channel ${channel.name} permissions:`, {
            sendMessages: true,
            embedLinks: embedPermission,
          });

          try {
            if (!embedPermission) {
              console.warn(
                `Bot missing EmbedLinks permission in channel ${channel.name} ` +
                `(${channel.id}) in guild ${guild.name}`,
              );

              await channel.send({
                content:
                  msg +
                  "\n(Note: Enhanced display requires EmbedLinks permission)",
                components: [row],
              });
            } else {
              await channel.send({
                content: msg,
                components: [row],
                embeds: [attendeeStatusEmbed],
              });
            }

            // Successfully sent the alert.
            break;
          } catch (error) {
            console.error(
              `Error sending message in channel ${channel.name} (${guild.name}):`,
              error,
            );

            // Try a plain message without buttons/embed.
            try {
              await channel.send({
                content:
                  msg + "\n(Buttons unavailable - check bot permissions)",
              });

              // Plain message succeeded, so we're done.
              break;
            } catch (fallbackError) {
              console.error(
                "Fallback message also failed:",
                fallbackError,
              );
            }
          }
        }
      } catch (error) {
        console.error(
          `Failed to send scheduled event alert for event ${this.id}:`,
          error,
        );
      }
    }, delay);

    console.log(this.timeoutId);
  }

  cancel(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private longTimeout(
    callback: () => void | Promise<void>,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    const maxDelay = 2_147_483_647;

    if (delay <= maxDelay) {
      return setTimeout(callback, delay);
    }

    return setTimeout(() => {
      this.timeoutId = this.longTimeout(
        callback,
        delay - maxDelay,
      );
    }, maxDelay);
  }
}
