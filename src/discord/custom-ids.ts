import type { RsvpStatus } from "../db/schema";

export type ButtonAction =
  | { kind: "rsvp"; status: RsvpStatus; eventId: string }
  | { kind: "cancel-event"; eventId: string };

const SNOWFLAKE = /^\d{15,25}$/;

export const customId = {
  rsvp: (status: RsvpStatus, eventId: string) => `rsvp:${status}:${eventId}`,
  cancelEvent: (eventId: string) => `event:cancel:${eventId}`,
};

/** Parse a button custom id, including the `will_show<id>` / `no_show<id>` ids of v0 alerts. */
export function parseCustomId(id: string): ButtonAction | null {
  const parts = id.split(":");
  if (parts.length === 3) {
    const [scope, verb, eventId] = parts as [string, string, string];
    if (!SNOWFLAKE.test(eventId)) return null;
    if (scope === "rsvp" && (verb === "going" || verb === "declined")) return { kind: "rsvp", status: verb, eventId };
    if (scope === "event" && verb === "cancel") return { kind: "cancel-event", eventId };
    return null;
  }
  const legacy = /^(will_show|no_show)(\d{15,25})$/.exec(id);
  if (legacy) return { kind: "rsvp", status: legacy[1] === "will_show" ? "going" : "declined", eventId: legacy[2]! };
  return null;
}
