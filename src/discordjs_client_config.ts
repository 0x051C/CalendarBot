import { Client, GatewayIntentBits } from "discord.js";

// Only non-privileged intents are needed: the bot reacts to scheduled-event
// gateway events and fetches everything else (subscribers, its own member,
// channels) over REST. No Developer Portal toggles are required to run it.
export const bot_client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
});
