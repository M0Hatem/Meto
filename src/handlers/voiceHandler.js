const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');

let secondaryStreamer = null;

async function getSecondaryStreamer(clientSecondary) {
  if (!secondaryStreamer && clientSecondary) {
    const { Streamer } = await import('@dank074/discord-video-stream');
    secondaryStreamer = new Streamer(clientSecondary);
  }
  return secondaryStreamer;
}

// Track voice connections globally (guildId -> { primary: state, secondary: state })
// state = { connection, channelId, authorizedDisconnect }
const voiceConnections = new Map();

// Helper function to set up and manage voice connections for a specific bot client (type: 'primary' | 'secondary')
async function setupVoiceConnection(botClient, guild, channel, type = 'primary') {
  try {
    if (type === 'secondary' && botClient.isSelfbot) {
      const streamer = await getSecondaryStreamer(botClient);
      if (!streamer) {
        throw new Error('Secondary streamer client is not ready or not initialized.');
      }

      await streamer.joinVoice(guild.id, channel.id, {
        selfDeaf: false,
        selfMute: true,
        selfVideo: false
      });

      if (!voiceConnections.has(guild.id)) {
        voiceConnections.set(guild.id, {});
      }

      const guildConns = voiceConnections.get(guild.id);
      guildConns[type] = {
        connection: streamer,
        channelId: channel.id,
        authorizedDisconnect: false
      };

      console.log(`[Voice - secondary] Joined VC ${channel.id} in guild ${guild.id} via Streamer.`);
      return;
    }

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
    const existing = guildConns[type];

    guildConns[type] = {
      connection,
      channelId: channel.id,
      authorizedDisconnect: false
    };

    // Set up connection event handlers only once
    if (!existing) {
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
    }
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
        if (typeof guildConns.secondary.connection.leaveVoice === 'function') {
          guildConns.secondary.connection.leaveVoice();
        } else {
          guildConns.secondary.connection.destroy();
        }
      } catch (e) {}
    }
  }
  voiceConnections.clear();
}

/**
 * Returns the internal voiceConnections Map.
 * Structure: guildId -> { primary: { connection, channelId, authorizedDisconnect }, secondary: ... }
 * @returns {Map}
 */
function getActiveConnections() {
  return voiceConnections;
}

/**
 * Check whether the primary bot has an active (non-destroyed) voice connection in a guild.
 * @param {string} guildId
 * @returns {boolean}
 */
function isInVC(guildId) {
  const guildConns = voiceConnections.get(guildId);
  if (!guildConns || !guildConns.primary) return false;
  try {
    return guildConns.primary.connection.state.status !== 'destroyed';
  } catch {
    return false;
  }
}

module.exports = {
  voiceConnections,
  setupVoiceConnection,
  initVoiceHandlers,
  cleanupVoiceConnections,
  getActiveConnections,
  isInVC,
  getSecondaryStreamer
};
