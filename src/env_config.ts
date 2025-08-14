export const ICAL_PATH = process.env?.ICAL_PATH ?? `${import.meta.dir}/ical/`;
export const DISCORD_TOKEN = process.env?.DISCORD_TOKEN;
export const ICAL_EVENT_DURATION = parseInt(process.env?.ICAL_EVENT_DURATION || "1800");
export const FILENAME = process.env?.CB_FILENAME ?? "treehouse.ics";
export const ALERT_LEAD_TIME = parseInt(process.env?.ALERT_LEAD_TIME ?? "5");
