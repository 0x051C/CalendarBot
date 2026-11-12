import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Rsvp, ScheduledEvent } from "../db/schema";
import { customId } from "./custom-ids";

const BLURPLE = 0x5865f2;
const GREY = 0x99aab5;
const CONTENT_LIMIT = 2000;
const FIELD_LIMIT = 1024;

export interface AlertView {
  event: Pick<ScheduledEvent, "id" | "guildId" | "name" | "description" | "url" | "startsAt" | "channelId" | "status">;
  /** Users who marked "Interested" on the Discord event. */
  interestedUserIds: readonly string[];
  rsvps: readonly Pick<Rsvp, "userId" | "status">[];
}

export interface Attendance {
  going: string[];
  declined: string[];
}

/** Interested users count as going unless they explicitly declined via the buttons. */
export function attendance(view: Pick<AlertView, "interestedUserIds" | "rsvps">): Attendance {
  const declined = new Set(view.rsvps.filter((r) => r.status === "declined").map((r) => r.userId));
  const going = new Set([...view.interestedUserIds, ...view.rsvps.filter((r) => r.status === "going").map((r) => r.userId)]);
  for (const id of declined) going.delete(id);
  return { going: [...going], declined: [...declined] };
}

const mention = (id: string) => `<@${id}>`;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** Join mentions until the next one would exceed `limit`, then summarise the rest. */
export function mentionList(ids: readonly string[], limit: number, empty = "—"): string {
  if (ids.length === 0) return empty;
  let out = "";
  for (let i = 0; i < ids.length; i++) {
    const next = (out ? " " : "") + mention(ids[i]!);
    const rest = ids.length - i;
    const suffix = ` …and ${rest} more`;
    if (out.length + next.length + (rest > 1 ? suffix.length : 0) > limit) return out ? out + suffix : suffix.trim();
    out += next;
  }
  return out;
}

export function buildContent(view: AlertView): string {
  const t = unix(view.event.startsAt);
  const head = `🔔 **${view.event.name}** starts <t:${t}:R> (<t:${t}:t>)`;
  const { going } = attendance(view);
  return going.length ? `${head}\n${mentionList(going, CONTENT_LIMIT - head.length - 1)}` : head;
}

export function buildEmbed(view: AlertView): APIEmbed {
  const { event } = view;
  const cancelled = event.status === "cancelled";
  const t = unix(event.startsAt);
  const { going, declined } = attendance(view);
  const lines = [
    event.description ? truncate(event.description, 300) : null,
    `🗓️ <t:${t}:F> (<t:${t}:R>)`,
    event.channelId ? `📍 <#${event.channelId}>` : null,
  ].filter(Boolean);

  return new EmbedBuilder()
    .setTitle(cancelled ? `❌ Cancelled: ${event.name}` : `📅 ${event.name}`)
    .setURL(event.url)
    .setDescription(lines.join("\n\n"))
    .setColor(cancelled ? GREY : BLURPLE)
    .addFields(
      { name: `✅ Going (${going.length})`, value: mentionList(going, FIELD_LIMIT), inline: true },
      { name: `❌ Can't make it (${declined.length})`, value: mentionList(declined, FIELD_LIMIT), inline: true },
    )
    .setFooter({ text: cancelled ? "This event was cancelled." : "Marked “Interested” on the event? You count as going." })
    .toJSON();
}

export function buildComponents(view: AlertView): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (view.event.status === "cancelled" || view.event.status === "completed") return [];
  const { event } = view;
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId.rsvp("going", event.id)).setLabel("Going").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(customId.rsvp("declined", event.id)).setLabel("Can't make it").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setURL(event.url).setLabel("View event").setStyle(ButtonStyle.Link),
  );
  if (event.channelId) {
    row.addComponents(
      new ButtonBuilder()
        .setURL(`https://discord.com/channels/${event.guildId}/${event.channelId}`)
        .setLabel("Join channel")
        .setStyle(ButtonStyle.Link),
    );
  }
  return [row];
}

/** Full message for the initial alert. Without Embed Links we degrade to plain text. */
export function buildAlertMessage(view: AlertView, opts: { embeds: boolean }) {
  const content = opts.embeds ? buildContent(view) : `${buildContent(view)}\n${view.event.url}`;
  return {
    content,
    embeds: opts.embeds ? [buildEmbed(view)] : [],
    components: buildComponents(view),
    allowedMentions: { parse: [] as never[], users: attendance(view).going.slice(0, 100) },
  };
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
