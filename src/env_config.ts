import path from "node:path";

/** Directory where per-guild .ics files are written. */
export const ICAL_PATH = process.env.ICAL_PATH ?? path.join(process.cwd(), "ical");
/** Discord bot token. */
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
/** Event length (seconds) used for the iCal DTEND, since Discord events often have no end time. */
export const ICAL_EVENT_DURATION = parseInt(process.env.ICAL_EVENT_DURATION || "1800");
/** File name of the generated calendar inside each guild folder. */
export const FILENAME = process.env.CB_FILENAME ?? "treehouse.ics";
/** Default number of minutes before an event starts to post the alert. */
export const ALERT_LEAD_TIME = parseInt(process.env.ALERT_LEAD_TIME ?? "5");
