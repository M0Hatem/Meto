require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client, GatewayIntentBits } = require('discord.js');

// Global exception and rejection handlers to prevent asynchronous library crashes from stopping the bot
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});

// Intercept and format raw WebSocket ErrorEvent logs to be cleaner
const originalConsoleError = console.error;
console.error = function (...args) {
  if (args[0] && args[0].type === 'error' && 'timeStamp' in args[0]) {
    console.log('📡 [Voice Connection] WebSocket connection dropped temporarily (reconnecting automatically).');
    return;
  }
  originalConsoleError.apply(console, args);
};

function checkIsBotToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve(false);
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/users/@me',
      method: 'GET',
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'MetoBot (https://github.com/M0Hatem/Meto)'
      }
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Import handlers
const { registerSlashCommands } = require('./handlers/commandRegistry');
const { initVoiceHandlers, cleanupVoiceConnections } = require('./handlers/voiceHandler');
const { cleanupWakeLoops } = require('./handlers/wakeHandler');
const { handleMessageCreate } = require('./handlers/messageHandler');
const { handleInteractionCreate } = require('./handlers/interactionHandler');
const { cleanupAllStreams, stopStreamForGuild } = require('./handlers/streamHandler');
const { cleanupPenalties, initializeAuditLogTracking } = require('./handlers/disconnectPenaltyHandler');

// Validate secondary client (self-bot user token) for VC/streaming
const tokenSecondary = process.env.DISCORD_TOKEN_SECONDARY;
if (!tokenSecondary || tokenSecondary === 'replace_this_with_your_actual_bot_token' || tokenSecondary.trim() === '') {
  console.warn('⚠️  DISCORD_TOKEN_SECONDARY is not set in .env. The secondary client (self-bot) and /stream command will be disabled.');
}

// Validate tertiary client (standard bot token) for broadcasting
const tokenTertiary = process.env.DISCORD_TOKEN_TERTIARY;
if (!tokenTertiary || tokenTertiary === 'replace_this_with_your_actual_bot_token' || tokenTertiary.trim() === '') {
  console.log('ℹ️  DISCORD_TOKEN_TERTIARY is not set in .env. The /bc command will fall back to the secondary bot.');
}

// Validate Discord token
const token = process.env.DISCORD_TOKEN;
if (!token || token === 'replace_this_with_your_actual_bot_token') {
  console.error('ERROR: DISCORD_TOKEN is not set in the .env file.');
  console.error('Please create a Discord bot at https://discord.com/developers/applications and paste the token.');
  process.exit(1);
}

// Configs
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10);

// Whitelisted Servers Config
function loadAllowedServers(filePath) {
  if (!filePath) return null;
  try {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`⚠️ Warning: ALLOWED_SERVERS_FILE specified but does not exist at: ${resolvedPath}`);
      return null;
    }
    const content = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (!content) {
      console.log(`ℹ️ Allowed servers file is empty. No guild restrictions applied.`);
      return null;
    }

    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const ids = parsed.map(id => String(id).trim()).filter(id => id.length > 0);
        console.log(`🔒 Loaded ${ids.length} allowed server ID(s) from JSON file: ${resolvedPath}`);
        return ids;
      }
    } catch (jsonErr) { }

    const ids = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('//'));

    console.log(`🔒 Loaded ${ids.length} allowed server ID(s) from text file: ${resolvedPath}`);
    return ids;
  } catch (err) {
    console.error(`❌ Error reading/parsing ALLOWED_SERVERS_FILE:`, err.message);
    return null;
  }
}

const allowedServers = loadAllowedServers(process.env.ALLOWED_SERVERS_FILE);

// Initialize Client with necessary Intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required to fetch member lists for broadcast
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.once('ready', async () => {
  console.log(`=========================================`);
  console.log('🤖 Meto Bot is online and ready!');
  console.log(`Logged in as: ${client.user.tag}`);
  console.log(`Configuration: Max File Size = ${MAX_FILE_SIZE_MB}MB`);
  console.log(`=========================================`);

  // Register commands globally
  await registerSlashCommands(client.user.id, token);

  // Initialize audit log tracking if secondary client is already ready
  primaryReady = true;
  tryInitAuditLogs();
});

// Message handler for processing Facebook links
client.on('messageCreate', async (message) => {
  await handleMessageCreate(message, client, clientSecondary, allowedServers, MAX_FILE_SIZE_MB);
});

// Initialize and login Secondary and Tertiary Bots if configured
let clientSecondary = null;
let clientTertiary = null;
let primaryReady = false;
let secondaryReady = false;

function tryInitAuditLogs() {
  console.log(`[tryInitAuditLogs] Checking ready status: primaryReady=${primaryReady}, clientSecondary=${!!clientSecondary}, secondaryReady=${secondaryReady}`);
  if (primaryReady && clientSecondary && secondaryReady) {
    initializeAuditLogTracking(client, clientSecondary);
  }
}

(async () => {
  if (tokenSecondary && tokenSecondary !== 'replace_this_with_your_actual_bot_token' && tokenSecondary.trim() !== '') {
    const isBot = await checkIsBotToken(tokenSecondary);
    if (isBot) {
      console.log('ℹ️ Secondary token detected as a BOT token. Running secondary client in standard Bot mode.');
      clientSecondary = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages
        ]
      });
      clientSecondary.isSelfbot = false;
    } else {
      console.log('ℹ️ Secondary token detected as a USER token. Running secondary client in self-bot Streamer mode.');
      const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
      clientSecondary = new SelfbotClient({
        checkUpdate: false
      });
      clientSecondary.isSelfbot = true;
    }

    clientSecondary.once('ready', async () => {
      console.log(`=========================================`);
      console.log(`🤖 Meto Bot (Secondary / ${clientSecondary.isSelfbot ? 'Self-bot' : 'Bot'}) is online and ready!`);
      console.log(`Logged in as: ${clientSecondary.user.tag}`);
      console.log(`=========================================`);

      // Initialize audit log tracking if primary client is already ready
      secondaryReady = true;
      tryInitAuditLogs();

      // Set Twitch streaming status
      try {
        if (clientSecondary.isSelfbot) {
          const { RichPresence } = require('discord.js-selfbot-v13');
          const r = new RichPresence(clientSecondary)
            .setApplicationId('1118658289161478275')
            .setType('STREAMING')
            .setURL('https://www.twitch.tv/m16afk')
            .setName('M16')
            .setDetails('KD');

          // Try fetching the target user and set its avatar as the large image
          try {
            const user = await clientSecondary.users.fetch('1118658289161478275');
            const avatarUrl = user.displayAvatarURL({ format: 'png', size: 1024 });
            if (avatarUrl) {
              r.setAssetsLargeImage(avatarUrl);
            }
          } catch (fetchErr) {
            console.warn('⚠️ Could not fetch user avatar for RichPresence:', fetchErr.message);
          }

          clientSecondary.user.setActivity(r);
        } else {
          const { ActivityType } = require('discord.js');
          clientSecondary.user.setPresence({
            activities: [{
              name: 'm16afk',
              type: ActivityType.Streaming,
              url: 'https://www.twitch.tv/m16afk'
            }]
          });
        }
        console.log(`📡 Set secondary client activity to Streaming m16afk (Twitch).`);
      } catch (activityErr) {
        console.error('⚠️ Failed to set secondary client activity:', activityErr.message);
      }
    });

    clientSecondary.on('messageCreate', async (message) => {
      const { handleSecondaryMessage } = require('./handlers/messageHandler');
      await handleSecondaryMessage(message, client, clientSecondary);
    });

    clientSecondary.login(tokenSecondary).catch(err => {
      console.error('Failed to log in secondary bot client:', err.message);
    });
  }

  // Initialize and login Tertiary Bot if configured
  if (tokenTertiary && tokenTertiary !== 'replace_this_with_your_actual_bot_token' && tokenTertiary.trim() !== '') {
    const isBot = await checkIsBotToken(tokenTertiary);
    if (isBot) {
      console.log('ℹ️ Tertiary token detected as a BOT token. Running tertiary client in standard Bot mode.');
      clientTertiary = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates
        ]
      });
      clientTertiary.isSelfbot = false;
    } else {
      console.log('ℹ️ Tertiary token detected as a USER token. Running tertiary client in self-bot mode.');
      const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
      clientTertiary = new SelfbotClient({
        checkUpdate: false
      });
      clientTertiary.isSelfbot = true;
    }

    clientTertiary.once('ready', () => {
      console.log(`=========================================`);
      console.log(`🤖 Meto Bot (Tertiary / ${clientTertiary.isSelfbot ? 'Self-bot' : 'Bot'}) is online and ready!`);
      console.log(`Logged in as: ${clientTertiary.user.tag}`);
      console.log(`=========================================`);
    });

    clientTertiary.login(tokenTertiary).catch(err => {
      console.error('Failed to log in tertiary bot client:', err.message);
    });
  }

  // Bind Voice Event Handlers for both clients
  initVoiceHandlers(client, clientSecondary);

  // Periodically check (every 5 minutes) if the secondary bot stream should be active but is closed, and restore it
  setInterval(async () => {
    if (!clientSecondary || !clientSecondary.readyAt) return;

    const { getActiveConnections, setupVoiceConnection } = require('./handlers/voiceHandler');
    const { activeStreams, restartStreamIfActive } = require('./handlers/streamHandler');

    if (activeStreams.size === 0) return; // Nothing to monitor

    console.log(`[StreamMonitor] Running health check for ${activeStreams.size} tracked stream(s)...`);

    for (const [guildId, activeInfo] of activeStreams.entries()) {
      try {
        const guildConns = getActiveConnections().get(guildId);
        if (!guildConns || !guildConns.primary) {
          // Primary bot is not in voice in this guild, skip
          console.log(`[StreamMonitor] [Guild: ${guildId}] Primary bot not in voice. Skipping.`);
          continue;
        }

        const primaryChannelId = guildConns.primary.channelId;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const channel = guild.channels.cache.get(primaryChannelId);
        if (!channel) continue;

        let needRejoin = false;
        let needStreamRestart = false;
        let reason = '';

        if (!guildConns.secondary || !guildConns.secondary.connection) {
          needRejoin = true;
          reason = 'secondary connection missing entirely';
        } else {
          const streamer = guildConns.secondary.connection;
          if (!streamer.voiceConnection) {
            needRejoin = true;
            reason = 'streamer.voiceConnection is null/undefined';
          } else if (!streamer.voiceConnection.streamConnection) {
            needStreamRestart = true;
            reason = 'streamConnection is null/undefined (Go Live not active)';
          } else {
            // Stream connection object exists — but is it actually alive?
            const sc = streamer.voiceConnection.streamConnection;

            // Check WebSocket readyState if available (1 = OPEN)
            const wsReady = sc.ws?.readyState;
            if (wsReady !== undefined && wsReady !== 1) {
              needStreamRestart = true;
              reason = `streamConnection WebSocket readyState is ${wsReady} (not OPEN)`;
            }

            // Check PeerConnection state to ensure the WebRTC transport is alive and hasn't failed/closed
            if (!needStreamRestart) {
              const pcState = sc.webRtcConn?.webRtcConn?.state();
              if (pcState && (pcState === 'failed' || pcState === 'closed')) {
                needStreamRestart = true;
                reason = `stream connection PeerConnection state is ${pcState}`;
              }
            }
          }
        }

        if (needRejoin) {
          console.log(`[StreamMonitor] [Guild: ${guildId}] Stream should be active but needs REJOIN. Reason: ${reason}`);
          // Clean up any stale secondary connection state first to prevent double-joining conflicts
          if (guildConns.secondary && guildConns.secondary.connection) {
            try { guildConns.secondary.connection.leaveVoice(); } catch (_) {}
          }
          await setupVoiceConnection(clientSecondary, guild, channel, 'secondary');
        } else if (needStreamRestart) {
          console.log(`[StreamMonitor] [Guild: ${guildId}] Stream should be active but needs RESTART. Reason: ${reason}`);
          await restartStreamIfActive(guildId);
        } else {
          console.log(`[StreamMonitor] [Guild: ${guildId}] Stream is healthy. ✅`);
        }
      } catch (monitorErr) {
        console.error(`[StreamMonitor] Error checking/restoring stream in guild ${guildId}:`, monitorErr.message);
      }
    }
  }, 5 * 60 * 1000); // 5 minutes

  // Auto-stop stream when the primary bot leaves a voice channel (only if it's an authorized disconnect, e.g. via /leave)
  client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.id === client.user.id && oldState.channelId && !newState.channelId) {
      const { voiceConnections } = require('./handlers/voiceHandler');
      const guildConns = voiceConnections.get(oldState.guild.id);
      const isAuthorized = guildConns?.primary?.authorizedDisconnect;
      if (isAuthorized) {
        stopStreamForGuild(oldState.guild.id);
      }
    }
  });

  // Handle voice channel deletion: recreate the channel and rejoin bots automatically
  client.on('channelDelete', async (channel) => {
    const { ChannelType } = require('discord.js');
    if (channel.type !== ChannelType.GuildVoice) return;

    const guildId = channel.guild.id;
    const { voiceConnections, setupVoiceConnection } = require('./handlers/voiceHandler');
    const guildConns = voiceConnections.get(guildId);

    if (guildConns) {
      const isTargetChannel = (guildConns.primary && guildConns.primary.channelId === channel.id) ||
        (guildConns.secondary && guildConns.secondary.channelId === channel.id);

      if (isTargetChannel) {
        console.log(`[Voice] Target VC "${channel.name}" (${channel.id}) was deleted in guild ${guildId}! Recreating and rejoining...`);
        try {
          // Clone the deleted channel with the exact same properties (name, category, permissions, settings)
          const newChannel = await channel.clone({
            reason: 'Restoring deleted voice channel containing Meto Bot'
          });
          console.log(`[Voice] Recreated channel "${channel.name}" (new ID: ${newChannel.id}) in guild ${guildId}`);

          // Update tracked channel ID for active connections
          if (guildConns.primary) {
            guildConns.primary.channelId = newChannel.id;
          }
          if (guildConns.secondary) {
            guildConns.secondary.channelId = newChannel.id;
          }

          // Rejoin primary client
          if (guildConns.primary) {
            console.log(`[Voice - primary] Rejoining new channel ${newChannel.id}...`);
            await setupVoiceConnection(client, channel.guild, newChannel, 'primary');
          }

          // Rejoin secondary client (user token self-bot or bot token)
          if (guildConns.secondary && clientSecondary && clientSecondary.readyAt) {
            console.log(`[Voice - secondary] Rejoining new channel ${newChannel.id}...`);
            await setupVoiceConnection(clientSecondary, channel.guild, newChannel, 'secondary');
          }
        } catch (err) {
          console.error('[Voice] Failed to recreate deleted channel or rejoin bots:', err);
        }
      }
    }
  });

  // Slash Commands interaction dispatching
  client.on('interactionCreate', async (interaction) => {
    await handleInteractionCreate(interaction, client, clientSecondary, clientTertiary);
  });

  // Start the bot
  client.login(token);
})();

// Create a dummy HTTP server to satisfy Render's port check if deployed as a Web Service (Free Tier)
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Meto Discord Bot is running successfully!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Health Check] Dummy HTTP server listening on port ${PORT} to pass Render deployment check.`);
});

// Graceful shutdown handling
const shutdown = (signal) => {
  console.log(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);
  server.close(() => {
    console.log('[Shutdown] Health check HTTP server closed.');
    try {
      // Stop wake loops
      cleanupWakeLoops();
      console.log('[Shutdown] All active wake loops stopped.');

      // Clear penalty timers
      cleanupPenalties();
      console.log('[Shutdown] All penalty trackers cleared.');

      // Stop all active streams
      cleanupAllStreams();
      console.log('[Shutdown] All active stream clients destroyed.');

      // Disconnect all voice connections
      cleanupVoiceConnections();
      console.log('[Shutdown] All active voice connections destroyed.');

      client.destroy();
      console.log('[Shutdown] Discord client (primary) connection destroyed.');

      if (clientSecondary) {
        clientSecondary.destroy();
        console.log('[Shutdown] Discord client (secondary) connection destroyed.');
      }

      if (clientTertiary) {
        clientTertiary.destroy();
        console.log('[Shutdown] Discord client (tertiary) connection destroyed.');
      }
    } catch (err) {
      console.error('[Shutdown] Error destroying Discord client:', err.message);
    }
    console.log('[Shutdown] Graceful shutdown complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
