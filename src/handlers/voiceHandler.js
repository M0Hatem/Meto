const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');

// Track voice connections globally (guildId -> { primary: state, secondary: state })
// state = { connection, channelId, authorizedDisconnect }
const voiceConnections = new Map();

// Helper function to set up and manage voice connections for a specific bot client (type: 'primary' | 'secondary')
async function setupVoiceConnection(botClient, guild, channel, type = 'primary') {
  try {
    // Fetch the guild using the specific client instance to obtain its correct voiceAdapterCreator
    const targetGuild = await botClient.guilds.fetch(guild.id).catch(() => guild);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: targetGuild.voiceAdapterCreator,
      selfDeaf: true,
      group: botClient.user.id
    });

    if (!voiceConnections.has(guild.id)) {
      voiceConnections.set(guild.id, {});
    }

    const guildConns = voiceConnections.get(guild.id);
    guildConns[type] = {
      connection,
      channelId: channel.id,
      authorizedDisconnect: false
    };

    // Set up connection event handlers
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      const currentGuildConns = voiceConnections.get(guild.id);
      const state = currentGuildConns ? currentGuildConns[type] : null;
      if (state && !state.authorizedDisconnect) {
        console.log(`[Voice - ${type}] Disconnected from voice in guild ${guild.id}. Reconnecting...`);
        try {
          await setupVoiceConnection(botClient, guild, channel, type);
        } catch (err) {
          console.error(`[Voice - ${type}] Failed to reconnect voice connection:`, err);
        }
      }
    });

    connection.on('error', (error) => {
      console.error(`[Voice - ${type}] Voice connection error in guild ${guild.id}:`, error);
    });
  } catch (err) {
    console.error(`[Voice - ${type}] Error joining channel ${channel.id}:`, err);
  }
}

// Function to handle automatic rejoining if the bot is moved to a different channel
async function handleVoiceStateUpdate(botClient, type, oldState, newState) {
  if (newState.id === botClient.user.id) {
    const guildId = newState.guild.id;
    const guildConns = voiceConnections.get(guildId);
    const state = guildConns ? guildConns[type] : null;
    
    // If the bot has active connection and shouldn't be disconnected
    // AND it has been moved to a different channel (newState.channelId is not null)
    // AND the new channel is different from the tracked target channel ID
    if (state && !state.authorizedDisconnect && newState.channelId !== null && newState.channelId !== state.channelId) {
      console.log(`[Voice - ${type}] Moved from target channel ${state.channelId} to ${newState.channelId} in guild ${guildId}. Rejoining target channel...`);
      try {
        await setupVoiceConnection(botClient, newState.guild, { id: state.channelId }, type);
      } catch (err) {
        console.error(`[Voice - ${type}] Failed to rejoin target channel:`, err);
      }
    }
  }
}

// Initialize listeners on bot clients
function initVoiceHandlers(client, clientSecondary) {
  client.on('voiceStateUpdate', (oldState, newState) => {
    handleVoiceStateUpdate(client, 'primary', oldState, newState);
  });

  if (clientSecondary) {
    clientSecondary.on('voiceStateUpdate', (oldState, newState) => {
      handleVoiceStateUpdate(clientSecondary, 'secondary', oldState, newState);
    });
  }
}

// Graceful cleanup
function cleanupVoiceConnections() {
  for (const [guildId, guildConns] of voiceConnections.entries()) {
    if (guildConns.primary) {
      try {
        guildConns.primary.authorizedDisconnect = true;
        guildConns.primary.connection.destroy();
      } catch (e) {}
    }
    if (guildConns.secondary) {
      try {
        guildConns.secondary.authorizedDisconnect = true;
        guildConns.secondary.connection.destroy();
      } catch (e) {}
    }
  }
  voiceConnections.clear();
}

module.exports = {
  voiceConnections,
  setupVoiceConnection,
  initVoiceHandlers,
  cleanupVoiceConnections
};
