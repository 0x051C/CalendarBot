import { Client, GatewayIntentBits } from "discord.js";
const gib = GatewayIntentBits;
export const bot_client = new Client({
  intents: [
    gib.GuildScheduledEvents,
    gib.Guilds,
    gib.GuildMessages,
    gib.GuildMembers,
    // gib.GuildVoiceStates,
    // gib.GuildMessageReactions,
    // gib.MessageContent,
  ],
});
