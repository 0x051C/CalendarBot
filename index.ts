import { Client, Events } from "discord.js";
import { bot_client } from "./src/discordjs_client_config";
import { EventHandler } from "./src/calendar/event_handler";
import { DISCORD_TOKEN } from "./src/env_config";

bot_client.once(Events.ClientReady, (client: Client) => {
  EventHandler.createInstance(client).then(
    handlerInstance => {
      client.on(Events.GuildScheduledEventCreate, async (se) => { void handlerInstance.on_create(se) });
      client.on(Events.GuildScheduledEventDelete, async (se) => { void handlerInstance.on_delete(se) });
      client.on(Events.GuildScheduledEventUpdate, async (_, se) => { void handlerInstance.on_update(se) });
      client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton()) {
          void handlerInstance.event_actionrow(interaction);
        } else if (interaction.isChatInputCommand()) {
          void handlerInstance.slash_commands(interaction);
        }
      });
    }
  );
})

bot_client.login(DISCORD_TOKEN);
