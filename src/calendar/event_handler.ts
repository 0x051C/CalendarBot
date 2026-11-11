import {
  type Guild as DiscordGuild,
  type Client as DiscordClient,
  REST,
  Routes,
  ApplicationCommandOptionType,
  EmbedBuilder,
} from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildScheduledEvent,
  PartialGuildScheduledEvent,
  User,
} from "discord.js";

import ical, { ICalCalendar, ICalCalendarMethod } from "ical-generator";
import { ICalEventStatus } from "ical-generator";

import { write_calendar_file } from "../write_file";
import { processEventData } from "./convert_event_data";
import { GuildScheduledEventAlert } from "./alert";
import { ALERT_LEAD_TIME, DISCORD_TOKEN } from "../env_config";
import { bot_client } from "../discordjs_client_config";

export class EventHandler {
  alert_offset: number = ALERT_LEAD_TIME;
  guildIdToICalendarMap: Map<string, ICalCalendar> = new Map();
  client: DiscordClient;
  alerts: Array<GuildScheduledEventAlert> = [];

  private constructor(client: DiscordClient) {
    this.client = client;
  }

  static async createInstance(client: DiscordClient) {
    let instance = new EventHandler(client);
    await instance.initialize();
    return instance;
  }

  private async initialize() {
    const commands = [
      {
        name: "alert",
        description: "Override alert time for events after command",
        options: [
          {
            name: "minutes",
            type: ApplicationCommandOptionType.Integer, // Expecting a number (integer)
            description:
              "The number of minutes before the event, if empty replies with current setting",
            required: false, // Make it a required parameter
          },
        ],
      },
    ];
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN || "");
    console.log("Handler initialize in progress.");
    for (let guild of this.client.guilds.cache.values()) {
      void (async () => {
        try {
          // WE update available commands on every even?
          await rest.put(
            Routes.applicationGuildCommands(bot_client.user!.id, guild.id),
            {
              body: commands,
            },
          );
        } catch (error) {
          console.error(error);
        }
      })();

      let ical_obj = ical({ name: `${guild.name} events` });
      ical_obj.prodId({
        company: "Discord Inc",
        product: "Discord",
        language: "EN",
      });
      ical_obj.method(ICalCalendarMethod.PUBLISH);
      this.guildIdToICalendarMap.set(guild.id, ical_obj);
      await this.fetch_events(guild);
      write_calendar_file(ical_obj.toString(), guild.name);
    }
  }

  async on_create(se: GuildScheduledEvent) {
    await this.fetch_events(se.guild);
    try {
      write_calendar_file(
        this.guildIdToICalendarMap.get(se.guildId)!.toString(),
        se.guild?.name ?? "",
      );
    } catch (er) {
      console.error("Could not find guild, error writing to file");
    }
  }

  async on_update(se: GuildScheduledEvent) {
    await this.fetch_events(se.guild);
    let events = this.guildIdToICalendarMap.get(se.guildId)!.events();
    if (!events) {
      console.error("could not fetch events from event handler");
    }
    for (let i = 0; i < events.length; i++) {
      if (events[i].id() == se.id) {
        events[i].status(ICalEventStatus.TENTATIVE);
        events[i].sequence(events[i].sequence() + 1);
      }
    }
    try {
      this.guildIdToICalendarMap.get(se.guildId)!.clear();
    } catch (err) {
      console.error(
        err,
        "could not clear ICal object, or it's not stored in the Map",
      );
    }
    this.guildIdToICalendarMap.get(se.guildId)!.events(events);
    write_calendar_file(
      this.guildIdToICalendarMap.get(se.guildId)!.toString(),
      se.guild?.name ?? "",
    );
  }

  async on_delete(se: GuildScheduledEvent | PartialGuildScheduledEvent) {
    const this_ical = this.guildIdToICalendarMap.get(se.guildId);
    if (!this_ical) {
      console.error(
        `Could not find the guild's ICalendar object, by using guild ID #${se.guildId} for event ${se.id}`,
      );
      return;
    }
    for (let alert of this.alerts) {
      if (alert.id == se.id) {
        alert.cancel();
      }
    }

    let events = this_ical.events();
    for (let i = 0; i < events.length; i++) {
      if (events[i].id() == se.id) {
        events[i].status(ICalEventStatus.CANCELLED);
        events[i].sequence(events[i].sequence() + 1);
      }
    }
    this_ical.clear();
    this_ical.events(events);
    write_calendar_file(this_ical.toString(), se.guild?.name ?? "Unknown");
  }

  async slash_commands(interaction: ChatInputCommandInteraction) {
    const { commandName } = interaction;
    if (commandName === "alert") {
      const minutes = interaction.options.getInteger("minutes");
      if (minutes !== null) {
        this.alert_offset = minutes;
      }
      await interaction.reply(
        `Alert lead time is set to ${this.alert_offset} minute(s).`,
      );
      if (minutes !== null) {
        // Reschedule alerts with the new lead time (after replying, so we
        // stay within Discord's 3s interaction deadline).
        await this.fetch_events(interaction.guild);
      }
    }
  }

  async event_actionrow(interaction: ButtonInteraction) {
    try {
      console.log(
        `Button interaction received: ${interaction.customId} from user ${interaction.user.tag}`,
      );

      let eventId: string;
      let isWillShow = false;
      let isNoShow = false;

      if (interaction.customId.startsWith("will_show")) {
        eventId = interaction.customId.slice("will_show".length);
        isWillShow = true;
      } else if (interaction.customId.startsWith("no_show")) {
        eventId = interaction.customId.slice("no_show".length);
        isNoShow = true;
      } else {
        console.error(`Unknown button customId: ${interaction.customId}`);
        await interaction.reply({
          content: "Unknown button action.",
          ephemeral: true,
        });
        return;
      }

      let event = this.alerts.find((al) => al.id === eventId);
      let discord_ev = interaction.guild?.scheduledEvents.cache.find(
        (ev) => ev.id === eventId,
      );

      if (!discord_ev) {
        console.error(`Could not find Discord event with ID: ${eventId}`);
        await interaction.reply({
          content: "Event not found.",
          ephemeral: true,
        });
        return;
      }

      // Check if user is event creator and they clicked "Can't join" (delete event)
      if (isNoShow && interaction.user.id === discord_ev?.creator?.id) {
        await discord_ev.delete();
        await interaction.message.edit({
          content: "Event cancelled by creator. 💀",
          embeds: [],
          components: [],
        });
        await interaction.deferUpdate();
        return;
      }

      let attending = (await discord_ev?.fetchSubscribers()) ?? [];

      // Update the embed if it exists
      if (interaction.message.embeds.length > 0) {
        const oldEmbed = interaction.message.embeds[0];
        const updatedEmbed = new EmbedBuilder(oldEmbed.data).setFields(
          oldEmbed.fields.map((field) => {
            if (field.name === "👥 Attendees") {
              return {
                name: "👥 Attendees",
                value:
                  attending.map((user) => user.user.tag).join("\n") || "None",
                inline: true,
              };
            }
            return field;
          }),
        );

        await interaction.message.edit({ embeds: [updatedEmbed] });
      }

      // Provide feedback to the user
      if (isWillShow) {
        await interaction.reply({
          content: "✅ Thanks for confirming your attendance!",
          ephemeral: true,
        });
      } else if (isNoShow) {
        await interaction.reply({
          content: "❌ Thanks for letting us know you can't make it.",
          ephemeral: true,
        });
      }
    } catch (error) {
      console.error("Error in event_actionrow:", error);
      try {
        await interaction.reply({
          content: "An error occurred processing your request.",
          ephemeral: true,
        });
      } catch (replyError) {
        console.error("Could not send error reply:", replyError);
      }
    }
  }

  async diagnoseBotPermissions(guild: DiscordGuild) {
    console.log(`\n=== Permission Diagnostic for ${guild.name} ===`);

    let botMember;
    try {
      botMember = await guild.members.fetchMe();
    } catch {
      console.error("Bot is not a member of this guild!");
      return;
    }

    console.log("Bot guild permissions:", {
      sendMessages: botMember.permissions.has("SendMessages"),
      embedLinks: botMember.permissions.has("EmbedLinks"),
      useSlashCommands: botMember.permissions.has("UseApplicationCommands"),
      manageEvents: botMember.permissions.has("ManageEvents"),
      viewChannels: botMember.permissions.has("ViewChannel"),
      readMessageHistory: botMember.permissions.has("ReadMessageHistory"),
    });

    // Check permissions in each channel
    const channels = await guild.channels.fetch();
    let canSendInChannels = 0;
    let totalTextChannels = 0;

    for (const [channelId, channel] of channels) {
      if (channel?.isTextBased()) {
        totalTextChannels++;
        const permissions = channel.permissionsFor(botMember);
        if (permissions?.has("SendMessages")) {
          canSendInChannels++;
        }
      }
    }

    console.log(
      `Can send messages in ${canSendInChannels}/${totalTextChannels} text channels`,
    );

    if (canSendInChannels === 0) {
      console.warn("⚠️  Bot cannot send messages in ANY text channels!");
      console.warn("   Ask server admin to grant 'Send Messages' permission");
    }

    console.log("=".repeat(50));
  }

  async fetch_events(guild: DiscordGuild | null) {
    if (guild) {
      const ical_obj = this.guildIdToICalendarMap.get(guild.id);
      if (!ical_obj) {
        console.log("couldn't find the ical object of the guild" + guild.id);
        return;
      }

      // Run diagnostic for guilds where buttons might not work
      await this.diagnoseBotPermissions(guild);

      ical_obj.clear();
      this.alerts.forEach((al) => al.cancel());
      this.alerts = [];
      let events = await guild.scheduledEvents.fetch();
      guild.scheduledEvents.fetch({ cache: false, withUserCount: true });
      console.log(
        `Fetched total of ${events.size} events for guild ${guild.name}.`,
      );
      for (let event of events.values()) {
        let st = event.scheduledStartAt;
        let alert = new Date(st!.getTime() - this.alert_offset * 60000);
        this.alerts.push(
          new GuildScheduledEventAlert(
            event.id,
            guild.id,
            st ? st : new Date(),
            alert,
          ),
        );
        ical_obj.createEvent(processEventData(event));
      }
      return events;
    }
  }
}
