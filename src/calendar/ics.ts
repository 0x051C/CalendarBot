import ical, { ICalCalendarMethod, ICalEventStatus } from "ical-generator";
import type { ScheduledEvent } from "../db/schema";

const STATUS = {
  scheduled: ICalEventStatus.CONFIRMED,
  active: ICalEventStatus.CONFIRMED,
  completed: ICalEventStatus.CONFIRMED,
  cancelled: ICalEventStatus.CANCELLED,
} as const;

/**
 * Render a guild's events as an iCalendar feed. Cancelled events stay in the
 * feed (STATUS:CANCELLED, higher SEQUENCE) so subscribed clients remove them
 * instead of keeping a stale copy.
 */
export function buildCalendar(
  guild: { id: string; name: string },
  events: readonly ScheduledEvent[],
  opts: { defaultDurationSeconds: number },
): string {
  const cal = ical({
    name: `${guild.name} events`,
    prodId: { company: "CalendarBot", product: "CalendarBot", language: "EN" },
    method: ICalCalendarMethod.PUBLISH,
  });
  for (const e of events) {
    cal.createEvent({
      id: e.id,
      sequence: e.sequence,
      summary: e.name,
      description: e.description,
      location: e.location,
      url: e.url,
      start: e.startsAt,
      end: e.endsAt ?? new Date(e.startsAt.getTime() + opts.defaultDurationSeconds * 1000),
      status: STATUS[e.status],
      created: e.createdAt,
      lastModified: e.updatedAt,
    });
  }
  return cal.toString();
}
