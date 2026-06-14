const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');

let secondaryStreamer = null;

// Stored client references (set in initVoiceHandlers) — needed for penalty audit-log lookups
let _primaryClient = null;
let _secondaryClient = null;

async function getSecondaryStreamer(clientSecondary) {
  if (!secondaryStreamer && clientSecondary) {
    const pkg = await import('@dank074/discord-video-stream');
    const { Streamer, BaseMediaConnection, VoiceOpCodesBinary } = pkg;

    // Patch BaseMediaConnection to prevent the MLS_PROPOSALS crash
    if (BaseMediaConnection && BaseMediaConnection.prototype && BaseMediaConnection.prototype.handleBinaryMessages) {
      const originalHandleBinaryMessages = BaseMediaConnection.prototype.handleBinaryMessages;
      BaseMediaConnection.prototype.handleBinaryMessages = function (msg) {
        const op = msg.readUint8(2);
        if (op === VoiceOpCodesBinary.MLS_PROPOSALS && !this._daveSession) {
          if (this._loggerDave && typeof this._loggerDave.debug === 'function') {
            this._loggerDave.debug("MLS proposal received but DAVE session is not initialized. Skipping to avoid crash.");
          }
          return;
        }
        try {
          originalHandleBinaryMessages.call(this, msg);
        } catch (err) {
          console.error('[BaseMediaConnection] Error handling binary message:', err);
        }
      };
      console.log('🛡️ Successfully patched BaseMediaConnection.handleBinaryMessages to prevent MLS_PROPOSALS crashes.');
    }

    secondaryStreamer = new Streamer(clientSecondary);
  }
  return secondaryStreamer;
}

// Track voice connections globally (guildId -> { primary: state, secondary: state })
// state = { connection, channelId, authorizedDisconnect }
const voiceConnections = new Map();

// Debounce: prevent multiple secondary rejoins within a short window
// guildId -> timestamp of last setupVoiceConnection call for secondary
const lastSecondaryJoin = new Map();
const SECONDARY_JOIN_COOLDOWN_MS = 3000; // 3 seconds

// Helper function to set up and manage voice connections for a specific bot client (type: 'primary' | 'secondary')
async function setupVoiceConnection(botClient, guild, channel, type = 'primary') {
  try {
    if (type === 'secondary' && botClient.isSelfbot) {
      // Debounce: skip if we just rejoined this guild recently
      const now = Date.now();
      const lastJoin = lastSecondaryJoin.get(guild.id) || 0;
      if (now - lastJoin < SECONDARY_JOIN_COOLDOWN_MS) {
        console.log(`[Voice - secondary] [Guild: ${guild.id}] Skipping rejoin — cooldown active (${now - lastJoin}ms since last join).`);
        return;
      }
      lastSecondaryJoin.set(guild.id, now);

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

      console.log(`[Voice - secondary] [Guild: ${guild.id}] Joined VC ${channel.id} via Streamer.`);
      
      // Auto-restart stream if it was active before the disconnect/move
      try {
        const { restartStreamIfActive } = require('./streamHandler');
        console.log(`[Voice - secondary] [Guild: ${guild.id}] Triggering stream check/restart...`);
        await restartStreamIfActive(guild.id);
      } catch (err) {
        console.error(`[Voice - secondary] [Guild: ${guild.id}] Failed to check/restart active stream:`, err.message);
      }

      // Post-rejoin penalty safety net (5s): catch rapid re-disconnects whose voiceStateUpdate may be missed
      const guildIdCapture = guild.id;
      setTimeout(async () => {
        try {
          if (!_primaryClient || !_secondaryClient) return;

          // Use the primary client (proper bot) to check the secondary bot's actual voice state
          const g = _primaryClient.guilds.cache.get(guildIdCapture);
          if (!g) return;
          const secondaryUserId = _secondaryClient.user?.id;
          if (!secondaryUserId) return;

          const member = await g.members.fetch(secondaryUserId).catch(() => null);
          if (member && !member.voice.channelId) {
            // Bot is NOT in voice 5s after rejoin — someone disconnected it again
            console.log(`[PenaltyVerify] [Guild: ${guildIdCapture}] Secondary bot not in voice 5s after rejoin. Checking for missed disconnect...`);

            const { findDisconnector, handleBotDisconnected, lastPenaltyTime } = require('./disconnectPenaltyHandler');

            // Only process if the voiceStateUpdate handler didn't already catch it (debounce check)
            const lastPenalty = lastPenaltyTime.get(guildIdCapture) || 0;
            if (Date.now() - lastPenalty < 4000) {
              console.log(`[PenaltyVerify] [Guild: ${guildIdCapture}] Penalty already processed recently. Skipping duplicate.`);
            } else {
              const executorId = await findDisconnector(g, _primaryClient, _secondaryClient);
              if (executorId) {
                console.log(`[PenaltyVerify] [Guild: ${guildIdCapture}] Found missed disconnect by ${executorId}. Applying penalty...`);
                await handleBotDisconnected(g, executorId, _secondaryClient, _primaryClient);
              }
            }
            // Note: no re-rejoin here — the voiceStateUpdate handler handles that
          }
        } catch (err) {
          console.error(`[PenaltyVerify] [Guild: ${guildIdCapture}] Error:`, err.message);
        }
      }, 5000);

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
      connection.on('stateChange', (oldState, newState) => {
        console.log(`[Voice - ${type}] [Guild: ${guild.id}] Connection state changed from ${oldState.status} to ${newState.status}.`);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        const currentGuildConns = voiceConnections.get(guild.id);
        const state = currentGuildConns ? currentGuildConns[type] : null;
        if (state && !state.authorizedDisconnect) {
          console.log(`[Voice - ${type}] [Guild: ${guild.id}] Unscheduled disconnection detected. Checking channel existence...`);
          // Check if channel was deleted
          let channelExists = guild.channels.cache.has(channel.id);
          if (!channelExists) {
            try {
              const fetched = await guild.channels.fetch(channel.id);
              channelExists = !!fetched;
            } catch (err) {
              channelExists = false;
            }
          }
          if (!channelExists) {
            console.log(`[Voice - ${type}] [Guild: ${guild.id}] Target VC ${channel.id} does not exist anymore. Skipping Disconnected event rejoin.`);
            return;
          }

          console.log(`[Voice - ${type}] [Guild: ${guild.id}] Channel still exists. Reconnecting voice connection...`);
          try {
            await setupVoiceConnection(botClient, guild, channel, type);
          } catch (err) {
            console.error(`[Voice - ${type}] [Guild: ${guild.id}] Failed to reconnect voice connection:`, err);
          }
        } else {
          console.log(`[Voice - ${type}] [Guild: ${guild.id}] Connection disconnected (authorized or no active state tracked).`);
        }
      });

      connection.on('error', (error) => {
        console.error(`[Voice - ${type}] [Guild: ${guild.id}] Voice connection error:`, error);
      });
    }
  } catch (err) {
    console.error(`[Voice - ${type}] [Guild: ${guild.id}] Error joining channel ${channel.id}:`, err);
  }
}

// Function to handle automatic rejoining if the bot is moved or disconnected
async function handleVoiceStateUpdate(botClient, type, oldState, newState) {
  if (newState.id === botClient.user.id) {
    const guildId = newState.guild.id;
    const guildConns = voiceConnections.get(guildId);
    const state = guildConns ? guildConns[type] : null;
    
    // If the bot has active connection and shouldn't be disconnected
    if (state && !state.authorizedDisconnect) {
      // ── Penalty tracking: detect when someone disrupts the streaming bot ──
      if (type === 'secondary' && _primaryClient && (newState.channelId === null || newState.channelId !== state.channelId)) {
        // Fire-and-forget: wait 2 s for the audit log to populate, then check who did it
        const capturedGuild = newState.guild;
        setTimeout(async () => {
          try {
            const { findDisconnector, handleBotDisconnected } = require('./disconnectPenaltyHandler');
            const executorId = await findDisconnector(capturedGuild, _primaryClient, _secondaryClient);
            if (executorId) {
              await handleBotDisconnected(capturedGuild, executorId, _secondaryClient || botClient, _primaryClient);
            } else {
              console.log(`[Penalty] [Guild: ${guildId}] Bot was disconnected/moved but could not identify who did it (no recent audit log entry).`);
            }
          } catch (err) {
            console.error(`[Penalty] [Guild: ${guildId}] Error during penalty check:`, err.message);
          }
        }, 2000);
      }

      if (newState.channelId === null) {
        // Check if the channel still exists in the guild.
        // If the channel was deleted, skip standard voiceStateUpdate rejoining.
        let channelExists = newState.guild.channels.cache.has(state.channelId);
        if (!channelExists) {
          try {
            const fetched = await newState.guild.channels.fetch(state.channelId);
            channelExists = !!fetched;
          } catch (fetchErr) {
            channelExists = false;
          }
        }

        if (!channelExists) {
          console.log(`[Voice - ${type}] Target VC ${state.channelId} does not exist anymore (possibly deleted). Skipping standard voiceStateUpdate rejoin.`);
          return;
        }

        console.log(`[Voice - ${type}] Kicked/Disconnected from target channel ${state.channelId} in guild ${guildId}. Rejoining...`);
        try {
          await setupVoiceConnection(botClient, newState.guild, { id: state.channelId }, type);
        } catch (err) {
          console.error(`[Voice - ${type}] Failed to rejoin target channel after disconnect:`, err);
        }
      } else if (newState.channelId !== state.channelId) {
        console.log(`[Voice - ${type}] Moved from target channel ${state.channelId} to ${newState.channelId} in guild ${guildId}. Rejoining target channel...`);
        try {
          await setupVoiceConnection(botClient, newState.guild, { id: state.channelId }, type);
        } catch (err) {
          console.error(`[Voice - ${type}] Failed to rejoin target channel:`, err);
        }
      }
    }
  }
}

// Initialize listeners on bot clients
function initVoiceHandlers(client, clientSecondary) {
  // Store references for audit-log / penalty lookups
  _primaryClient = client;
  _secondaryClient = clientSecondary;

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
