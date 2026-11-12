import { RESTJSONErrorCodes, type Guild, type NewsChannel, type TextChannel } from "discord.js";
import type { AlertRepository } from "../db/repos/alerts";
import type { DueAlert } from "../db/repos/events";
import type { RsvpRepository } from "../db/repos/rsvps";
import type { ScheduledEvent } from "../db/schema";
import type { Logger } from "../logger";
import { buildAlertMessage, buildComponents, buildEmbed, type AlertView } from "../discord/alert-message";
import { resolveAlertChannel } from "../discord/channel-resolver";

const GONE = new Set<number>([RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel]);

/** Composes, posts and updates alert messages. */
export class AlertService {
  constructor(
    private readonly deps: {
      alerts: AlertRepository;
      rsvps: RsvpRepository;
      logger: Logger;
    },
  ) {}

  async buildView(event: ScheduledEvent, guild: Guild): Promise<AlertView> {
    let interestedUserIds: string[] = [];
    try {
      const live = await guild.scheduledEvents.fetch(event.id);
      const subscribers = await live.fetchSubscribers({ limit: 100 });
      interestedUserIds = subscribers.map((s) => s.user.id);
    } catch (err) {
      this.deps.logger.debug({ err, eventId: event.id }, "could not fetch event subscribers");
    }
    return { event, interestedUserIds, rsvps: await this.deps.rsvps.list(event.id) };
  }

  /** Post the alert for a due event. Throws if there is nowhere to post. */
  async deliver(due: DueAlert, guild: Guild): Promise<{ channelId: string; messageId: string }> {
    const { choice, overrideProblem } = await resolveAlertChannel(guild, due.channelOverride);
    if (overrideProblem) {
      this.deps.logger.warn(
        { guildId: guild.id, channelId: due.channelOverride, problem: overrideProblem },
        "configured alert channel is unusable; falling back",
      );
    }
    if (!choice) throw new Error("no text channel the bot can post in");

    const channel = guild.channels.cache.get(choice.channelId) as TextChannel | NewsChannel;
    const view = await this.buildView(due.event, guild);
    const message = await channel.send(buildAlertMessage(view, { embeds: choice.canEmbed }));
    return { channelId: channel.id, messageId: message.id };
  }

  /** Re-render alert messages already posted for this event (RSVP change, edit, cancellation). */
  async refreshPosted(event: ScheduledEvent, guild: Guild): Promise<void> {
    const posted = await this.deps.alerts.postedMessages(event.id);
    if (posted.length === 0) return;
    const view = await this.buildView(event, guild);
    for (const p of posted) {
      try {
        const channel = guild.channels.cache.get(p.channelId!) as TextChannel | NewsChannel | undefined;
        if (!channel) continue;
        const message = await channel.messages.fetch(p.messageId!);
        await message.edit(
          message.embeds.length
            ? { embeds: [buildEmbed(view)], components: buildComponents(view) }
            : { components: buildComponents(view) },
        );
      } catch (err) {
        if (GONE.has((err as { code?: number }).code ?? 0)) continue;
        this.deps.logger.warn({ err, eventId: event.id, messageId: p.messageId }, "failed to update alert message");
      }
    }
  }
}
