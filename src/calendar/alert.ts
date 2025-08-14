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
  start: Date | null;
  leadTime: Date | null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, guild_id: string, start: Date, reminderTime: Date) {
    this.id = id;
    this.start = start;
    this.guild_id = guild_id;
    this.leadTime = reminderTime;
    let alert_delay = undefined;
    try {
      alert_delay = reminderTime.getTime() - new Date().getTime();
    } catch (er) {
      console.error(
        `Lead Time (${reminderTime}) is undefined during timeout setup.`,
      );
      return;
    }
    const g = bot_client.guilds.cache.get(guild_id);
    if (g?.id === "1030185189265133677" || g?.name === "Yutzin's Hive") {
      alert_delay = 1000;
    }

    if (this.start > new Date() && alert_delay > 0) {
      this.timeoutId = this.longTimeout(async () => {
        const guild = await bot_client.guilds.fetch(this.guild_id);
        if (!guild) {
          console.error("Error fetching guild");
          return;
        }
        const botMember = guild.members.cache.get(bot_client.user!.id);
        // Iterate over all channels in the guild
        for (const channel of (await guild.channels.fetch()).values()) {
          // Check if the channel is a text-based channel
          if (channel && botMember) {
            // Fetch the bot's permissions in the channel
            const permissions = channel.permissionsFor(botMember);

            // Check if the bot has permission to send messages
            if (
              permissions &&
              permissions.has(PermissionFlagsBits.SendMessages)
            ) {
              let event = guild.scheduledEvents.cache.get(this.id);

              const subscribers = await event!.fetchSubscribers();

              console.log(`Subscribers for ${event!.name}:`);
              subscribers.forEach((subscriber) => {
                console.log(subscriber.user.tag); // Prints the usernames of subscribers
              });

              try {
                if (event?.channel) {
                  for (let member of event!.channel!.members.values()) {
                    // Members. . .
                  }
                }
              } catch (error) {
                console.error("failed to fetch members of the event channel.");
              }
              let atty_string = subscribers
                .map((atty) => `<@${atty.user.id}>`)
                .join(" ");
              let msg = `${event?.url}\n${event?.name} scheduled to start <t:${Math.floor(start.getTime() / 1000)}:R>, ${atty_string} please join!\n`;

              let attendee_status_embed = new EmbedBuilder()
                .setTitle(`📅 ${event?.name}`)
                .setDescription(
                  `Event starts <t:${Math.floor(start.getTime() / 1000)}:R>`,
                )
                .addFields({
                  name: "👥 Attendees",
                  value:
                    subscribers.map((atty) => atty.user.tag).join("\n") ||
                    "None",
                  inline: true,
                })
                .setColor(0x5865f2)
                .setTimestamp();
              let buttons = [];
              let showButton = new ButtonBuilder()
                .setLabel("Will join")
                .setStyle(ButtonStyle.Success)
                .setCustomId(`will_show${event?.id}`);
              buttons.push(showButton);

              let noshowButton = new ButtonBuilder()
                .setLabel("Can't join")
                .setStyle(ButtonStyle.Danger)
                .setCustomId(`no_show${event?.id}`);
              buttons.push(noshowButton);

              if (event?.channel) {
                let joinChannelButton = new ButtonBuilder()
                  .setLabel("Event link")
                  .setStyle(ButtonStyle.Link)
                  .setURL(event.channel.url);
                buttons.push(joinChannelButton);
              }

              let row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                buttons,
              );
              try {
                // Check if bot has permissions for buttons/components
                const embedPermission =
                  permissions &&
                  permissions.has(PermissionFlagsBits.EmbedLinks);
                const useExternalEmojisPermission =
                  permissions &&
                  permissions.has(PermissionFlagsBits.UseExternalEmojis);

                // Log permission status for debugging
                console.log(`Channel ${channel.name} permissions:`, {
                  sendMessages: permissions?.has(
                    PermissionFlagsBits.SendMessages,
                  ),
                  embedLinks: embedPermission,
                  useExternalEmojis: useExternalEmojisPermission,
                });

                if (!embedPermission) {
                  console.warn(
                    `Bot missing EmbedLinks permission in channel ${channel.name} (${channel.id}) in guild ${guild.name}`,
                  );
                  // Send without embed but keep buttons
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
                    embeds: [attendee_status_embed],
                  });
                }
              } catch (error) {
                console.error(
                  `Error sending message in channel ${channel?.name} (${guild.name}):`,
                  error,
                );

                // Fallback: try sending without components if there's an error
                try {
                  await channel.send({
                    content:
                      msg + "\n(Buttons unavailable - check bot permissions)",
                  });
                } catch (fallbackError) {
                  console.error(`Fallback message also failed:`, fallbackError);
                }
                continue;
              }

              break; // Break out of the loop on the first writable channel
            }
          }
        }
      }, alert_delay);
      console.log(this.timeoutId);
    }
  }
  cancel() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private longTimeout(callback: Bun.TimerHandler, delay: number): Timer {
    const maxDelay = 2147483647;
    if (delay <= 0) {
      return setTimeout(() => {}, 0);
    }
    if (delay > maxDelay) {
      return setTimeout(
        () => this.longTimeout(callback, delay - maxDelay),
        maxDelay,
      );
    } else {
      return setTimeout(callback, delay);
    }
  }
}
