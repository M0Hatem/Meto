require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client, GatewayIntentBits } = require('discord.js');

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

// Validate secondary client (self-bot user token) for VC/streaming
const tokenSecondary = process.env.DISCORD_TOKEN_SECONDARY;
if (!tokenSecondary || tokenSecondary === 'replace_this_with_your_actual_bot_token' || tokenSecondary.trim() === '') {
  console.warn('⚠️  DISCORD_TOKEN_SECONDARY is not set in .env. The secondary client (self-bot) and /stream command will be disabled.');
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
    } catch (jsonErr) {}

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
});

// Message handler for processing Facebook links
client.on('messageCreate', async (message) => {
  await handleMessageCreate(message, client, allowedServers, MAX_FILE_SIZE_MB);
});

// Initialize and login Secondary Bot if configured
let clientSecondary = null;

(async () => {
  if (tokenSecondary && tokenSecondary !== 'replace_this_with_your_actual_bot_token' && tokenSecondary.trim() !== '') {
    const isBot = await checkIsBotToken(tokenSecondary);
    if (isBot) {
      console.log('ℹ️ Secondary token detected as a BOT token. Running secondary client in standard Bot mode.');
      clientSecondary = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates
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

    clientSecondary.once('ready', () => {
      console.log(`=========================================`);
      console.log(`🤖 Meto Bot (Secondary / ${clientSecondary.isSelfbot ? 'Self-bot' : 'Bot'}) is online and ready!`);
      console.log(`Logged in as: ${clientSecondary.user.tag}`);
      console.log(`=========================================`);
    });

    clientSecondary.login(tokenSecondary).catch(err => {
      console.error('Failed to log in secondary bot client:', err.message);
    });
  }

  // Bind Voice Event Handlers for both clients
  initVoiceHandlers(client, clientSecondary);

  // Auto-stop stream when the primary bot leaves a voice channel
  client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.id === client.user.id && oldState.channelId && !newState.channelId) {
      stopStreamForGuild(oldState.guild.id);
    }
  });

  // Slash Commands interaction dispatching
  client.on('interactionCreate', async (interaction) => {
    await handleInteractionCreate(interaction, client, clientSecondary);
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
    } catch (err) {
      console.error('[Shutdown] Error destroying Discord client:', err.message);
    }
    console.log('[Shutdown] Graceful shutdown complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
