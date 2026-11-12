import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type NewsChannel,
  type TextChannel,
} from "discord.js";

export interface ChannelCandidate {
  id: string;
  type: ChannelType;
  position: number;
  canView: boolean;
  canSend: boolean;
  canEmbed: boolean;
}

export type ChannelSource = "override" | "system" | "fallback";

export interface ChannelChoice {
  channelId: string;
  source: ChannelSource;
  canEmbed: boolean;
}

export interface Resolution {
  choice: ChannelChoice | null;
  /** Set when an override is configured but unusable (deleted, or missing permissions). */
  overrideProblem: "missing" | "no-permission" | null;
}

const ALERTABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const usable = (c: ChannelCandidate) => ALERTABLE.has(c.type) && c.canView && c.canSend;

/**
 * Pick where to post alerts: the `/alert channel` override, else the server's
 * system channel, else the top-most text channel the bot can write to.
 */
export function chooseAlertChannel(opts: {
  candidates: readonly ChannelCandidate[];
  overrideId: string | null;
  systemChannelId: string | null;
}): Resolution {
  const byId = new Map(opts.candidates.map((c) => [c.id, c]));
  let overrideProblem: Resolution["overrideProblem"] = null;
  const pick = (c: ChannelCandidate, source: ChannelSource): ChannelChoice => ({ channelId: c.id, source, canEmbed: c.canEmbed });

  if (opts.overrideId) {
    const c = byId.get(opts.overrideId);
    if (!c) overrideProblem = "missing";
    else if (!usable(c)) overrideProblem = "no-permission";
    else return { choice: pick(c, "override"), overrideProblem };
  }
  const system = opts.systemChannelId ? byId.get(opts.systemChannelId) : undefined;
  if (system && usable(system)) return { choice: pick(system, "system"), overrideProblem };

  const first = [...opts.candidates].filter(usable).sort((a, b) => a.position - b.position)[0];
  return { choice: first ? pick(first, "fallback") : null, overrideProblem };
}

export function toCandidate(channel: TextChannel | NewsChannel, me: GuildMember): ChannelCandidate {
  const perms = channel.permissionsFor(me);
  return {
    id: channel.id,
    type: channel.type,
    position: channel.rawPosition,
    canView: perms?.has(PermissionFlagsBits.ViewChannel) ?? false,
    canSend: perms?.has(PermissionFlagsBits.SendMessages) ?? false,
    canEmbed: perms?.has(PermissionFlagsBits.EmbedLinks) ?? false,
  };
}

/** Build candidates from a live guild and resolve the alert channel. */
export async function resolveAlertChannel(guild: Guild, overrideId: string | null): Promise<Resolution> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const candidates = guild.channels.cache
    .filter((c): c is TextChannel | NewsChannel => ALERTABLE.has(c.type))
    .map((c) => toCandidate(c, me));
  return chooseAlertChannel({ candidates, overrideId, systemChannelId: guild.systemChannelId });
}
