import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type ButtonInteraction,
} from "discord.js";
import type { AlertService } from "../../alerts/alert-service";
import type { EventRepository } from "../../db/repos/events";
import type { RsvpRepository } from "../../db/repos/rsvps";
import { buildComponents, buildEmbed } from "../alert-message";
import { customId, type ButtonAction } from "../custom-ids";
import type { EventSync } from "../event-sync";

const ephemeral = MessageFlags.Ephemeral;

export class ButtonHandler {
  constructor(
    private readonly deps: {
      events: EventRepository;
      rsvps: RsvpRepository;
      alertService: AlertService;
      eventSync: EventSync;
    },
  ) {}

  async handle(interaction: ButtonInteraction<"cached">, action: ButtonAction): Promise<void> {
    const event = await this.deps.events.get(action.eventId);
    if (!event || event.status === "cancelled" || event.status === "completed") {
      await interaction.reply({ content: "This event is no longer open for RSVPs.", flags: ephemeral });
      return;
    }
    if (action.kind === "cancel-event") return this.cancel(interaction, action.eventId, event.creatorId);

    // Acknowledge first: fetching subscribers can take longer than Discord's 3s window.
    await interaction.deferUpdate();
    await this.deps.rsvps.set(event.id, interaction.user.id, action.status);

    if (interaction.message.embeds.length > 0) {
      const view = await this.deps.alertService.buildView(event, interaction.guild);
      await interaction.editReply({ embeds: [buildEmbed(view)], components: buildComponents(view) });
    }

    const isCreator = event.creatorId === interaction.user.id;
    if (action.status === "going") {
      await interaction.followUp({ content: `✅ You're on the list for **${event.name}**.`, flags: ephemeral });
    } else if (isCreator) {
      await interaction.followUp({
        content: `You created **${event.name}**. Do you want to cancel it for everyone?`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(customId.cancelEvent(event.id))
              .setLabel("Cancel event for everyone")
              .setStyle(ButtonStyle.Danger),
          ),
        ],
        flags: ephemeral,
      });
    } else {
      await interaction.followUp({ content: `Got it — you can't make **${event.name}**.`, flags: ephemeral });
    }
  }

  private async cancel(interaction: ButtonInteraction<"cached">, eventId: string, creatorId: string | null) {
    const allowed =
      interaction.user.id === creatorId || interaction.memberPermissions.has(PermissionFlagsBits.ManageEvents);
    if (!allowed) {
      await interaction.reply({ content: "Only the event's creator or a moderator can cancel it.", flags: ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      await interaction.guild.scheduledEvents.delete(eventId);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === RESTJSONErrorCodes.MissingPermissions) {
        await interaction.editReply({ content: "I need the **Manage Events** permission to cancel events.", components: [] });
        return;
      }
      if (code !== RESTJSONErrorCodes.UnknownGuildScheduledEvent) throw err;
    }
    await this.deps.eventSync.cancel(eventId, interaction.guild);
    await interaction.editReply({ content: "🗑️ Event cancelled. The alert has been updated for everyone.", components: [] });
  }
}
