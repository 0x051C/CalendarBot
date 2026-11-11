import { Client, GatewayIntentBits } from "discord.js";
const gib = GatewayIntentBits;
export const bot_client = new Client({
  intents:
    [
      gib.GuildMembers,
      gib.Guilds,
      gib.GuildScheduledEvents,
      gib.MessageContent,
      gib.GuildMessageReactions,
    ]

});
