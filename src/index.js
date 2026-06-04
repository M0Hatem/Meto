require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, AttachmentBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');
const { detectFacebookLink } = require('./utils/linkDetector');
const { downloadVideo } = require('./utils/videoDownloader');
const { createVideoEmbed } = require('./utils/embedBuilder');
const { sendWebhookMessage } = require('./utils/webhookHandler');

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

    // Try parsing as JSON first
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const ids = parsed.map(id => String(id).trim()).filter(id => id.length > 0);
        console.log(`🔒 Loaded ${ids.length} allowed server ID(s) from JSON file: ${resolvedPath}`);
        return ids;
      }
    } catch (jsonErr) {
      // If JSON parsing fails, fallback to line-by-line parsing
    }

    // Line-by-line parsing (for .txt or simple list files)
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

  // Register application slash commands
  const commands = [
    {
      name: 'join',
      description: 'Forces the bot to join your voice channel and persist there indefinitely.'
    },
    {
      name: 'leave',
      description: 'Disconnects the bot from the voice channel (Authorized users only).'
    }
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('[Slash Commands] Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('[Slash Commands] Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('[Slash Commands] Error registering application commands:', error);
  }
});

client.on('messageCreate', async (message) => {
  // Ignore messages from bots (prevent infinite loops)
  if (message.author.bot) return;

  // Check if server is whitelisted (if whitelist is active)
  if (allowedServers && (!message.guildId || !allowedServers.includes(message.guildId))) {
    return;
  }

  // --- REPLY DETECTION AND ORIGINAL OWNER NOTIFICATION ---
  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (referencedMessage) {
        // Check if the referenced message is a Meto bot/webhook message by checking footer text
        const hasMetoEmbed = referencedMessage.embeds && referencedMessage.embeds.some(embed => 
          embed.footer && embed.footer.text && embed.footer.text.includes('Meto • Facebook Reels & Videos')
        );

        if (hasMetoEmbed) {
          // Find original owner from the embed fields
          let originalOwnerId = null;
          for (const embed of referencedMessage.embeds) {
            const sharedByField = embed.fields && embed.fields.find(f => f.name && f.name.includes('Shared By'));
            if (sharedByField) {
              const match = sharedByField.value.match(/<@!?(\d+)>/);
              if (match) {
                originalOwnerId = match[1];
                break;
              }
            }
          }

          if (originalOwnerId && originalOwnerId !== message.author.id) {
            // Mention the original owner and delete the notification after 1 second
            const notification = await message.channel.send({
              content: `<@${originalOwnerId}>, <@${message.author.id}> replied to your shared reel!`
            }).catch(() => null);

            if (notification) {
              setTimeout(async () => {
                await notification.delete().catch(() => null);
              }, 1000);
            }
          }
        }
      }
    } catch (err) {
      console.error('Error in Meto reply detection:', err);
    }
  }
  // --- END OF REPLY DETECTION ---

  // Scan message content for Facebook video/reel links
  const fbUrl = detectFacebookLink(message.content);
  if (!fbUrl) return;

  console.log(`[FB Match] Found URL in message by ${message.author.tag}: ${fbUrl}`);
  
  let processingReaction = null;
  let videoInfo = null;

  try {
    // 1. Add reaction indicating bot is processing
    try {
      processingReaction = await message.react('⏳');
    } catch (reactErr) {
      console.warn('Could not add processing reaction (missing permissions).');
    }

    // Indicate bot is typing in channel
    await message.channel.sendTyping();

    // 2. Download the video under size limit
    videoInfo = await downloadVideo(fbUrl, MAX_FILE_SIZE_MB);

    // Clean original text by removing the Facebook URL
    const cleanContent = message.content.replace(fbUrl, '').trim();

    // 3. Create rich embed and attachment
    const embed = createVideoEmbed(videoInfo, message.author);
    const attachment = new AttachmentBuilder(videoInfo.filePath, { name: 'meto_video.mp4' });

    let sentSuccess = false;

    // 4. Send via Webhook (impersonating the user)
    try {
      await sendWebhookMessage(message.channel, client.user, message.author, {
        content: cleanContent || undefined,
        files: [attachment],
        embeds: [embed]
      });
      sentSuccess = true;
    } catch (webhookErr) {
      console.warn(`[Webhook Error] Falling back to standard reply: ${webhookErr.message}`);
      
      // Fallback: Send video + embed as a normal reply if webhook fails (e.g. missing permissions)
      await message.reply({
        embeds: [embed],
        files: [attachment],
        allowedMentions: { repliedUser: false }
      });
      sentSuccess = true;
    }

    // 5. Delete the original message containing the raw link
    if (sentSuccess) {
      try {
        await message.delete();
      } catch (deleteErr) {
        console.warn('Could not delete original message (missing Manage Messages permission).');
      }
    }

    // 6. Clean up reaction if original message is still accessible (should be deleted, but safety first)
    if (processingReaction) {
      try {
        await processingReaction.users.remove(client.user.id);
      } catch (e) {}
    }

    console.log(`[Success] Video uploaded successfully: ${videoInfo.title} (${videoInfo.fileSizeMB}MB)`);

  } catch (error) {
    console.error(`[Error] Failed to process Facebook URL: ${fbUrl}`);
    console.error(error);

    // Clean up processing reaction and add warning mark
    if (processingReaction) {
      try {
        await processingReaction.users.remove(client.user.id);
        await message.react('❌');
      } catch (e) {}
    }

    // Reply with a helpful error message
    try {
      await message.reply({
        content: `❌ **Failed to process Facebook Video**\n> ${error.message || 'An unexpected error occurred while downloading or uploading the video.'}`,
        allowedMentions: { repliedUser: false }
      });
    } catch (replyErr) {
      console.error('Could not send error reply to Discord channel:', replyErr.message);
    }
  } finally {
    // Always clean up downloaded files
    if (videoInfo && typeof videoInfo.cleanUp === 'function') {
      videoInfo.cleanUp();
    }
  }
});

// Track voice connections globally (guildId -> { primary: state, secondary: state })
// state = { connection, channelId, authorizedDisconnect }
const voiceConnections = new Map();

// Helper function to set up and manage voice connections for a specific bot client (type: 'primary' | 'secondary')
function setupVoiceConnection(botClient, guild, channel, type = 'primary') {
  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
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
          setupVoiceConnection(botClient, guild, channel, type);
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
function handleVoiceStateUpdate(botClient, type, oldState, newState) {
  if (newState.id === botClient.user.id) {
    const guildId = newState.guild.id;
    const guildConns = voiceConnections.get(guildId);
    const state = guildConns ? guildConns[type] : null;
    
    // If the bot has active connection and shouldn't be disconnected
    // AND it has been moved to a different channel (newState.channelId is not null, which means it wasn't disconnected entirely)
    // AND the new channel is different from the tracked target channel ID
    if (state && !state.authorizedDisconnect && newState.channelId !== null && newState.channelId !== state.channelId) {
      console.log(`[Voice - ${type}] Moved from target channel ${state.channelId} to ${newState.channelId} in guild ${guildId}. Rejoining target channel...`);
      try {
        // Move back to target channel
        setupVoiceConnection(botClient, newState.guild, { id: state.channelId }, type);
      } catch (err) {
        console.error(`[Voice - ${type}] Failed to rejoin target channel:`, err);
      }
    }
  }
}

// Register voiceStateUpdate listener for primary client
client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(client, 'primary', oldState, newState);
});

// Initialize and login Secondary Bot if configured
let clientSecondary = null;
const tokenSecondary = process.env.DISCORD_TOKEN_SECONDARY;

if (tokenSecondary && tokenSecondary !== 'replace_this_with_your_actual_bot_token' && tokenSecondary.trim() !== '') {
  clientSecondary = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  clientSecondary.once('ready', () => {
    console.log(`=========================================`);
    console.log('🤖 Meto Bot (Secondary) is online and ready!');
    console.log(`Logged in as: ${clientSecondary.user.tag}`);
    console.log(`=========================================`);
  });

  clientSecondary.on('voiceStateUpdate', (oldState, newState) => {
    handleVoiceStateUpdate(clientSecondary, 'secondary', oldState, newState);
  });

  clientSecondary.login(tokenSecondary).catch(err => {
    console.error('Failed to log in secondary bot client:', err.message);
  });
}

// Handle Slash Commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'join') {
    const member = interaction.member;
    if (!member || !member.voice.channel) {
      return interaction.reply({
        content: '❌ You must be in a voice channel to use this command.',
        ephemeral: true
      });
    }

    try {
      // Connect primary bot
      setupVoiceConnection(client, interaction.guild, member.voice.channel, 'primary');

      // Connect secondary bot if active
      let secondaryJoinedMessage = '';
      if (clientSecondary && clientSecondary.readyAt) {
        setupVoiceConnection(clientSecondary, interaction.guild, member.voice.channel, 'secondary');
        secondaryJoinedMessage = ` (along with **${clientSecondary.user.username}**)`;
      }

      await interaction.reply({
        content: `🔊 Joined voice channel **${member.voice.channel.name}**${secondaryJoinedMessage}! I will remain here indefinitely.`,
      });
    } catch (error) {
      console.error('[Voice] Error joining channel:', error);
      await interaction.reply({
        content: '❌ Failed to join the voice channel.',
        ephemeral: true
      });
    }
  } else if (commandName === 'leave') {
    const authorizedUserId = '476908643711713280';
    if (interaction.user.id !== authorizedUserId) {
      return interaction.reply({
        content: `❌ Only the authorized user (<@${authorizedUserId}>) is allowed to disconnect the bot.`,
        ephemeral: true
      });
    }

    const guildConns = voiceConnections.get(interaction.guildId);
    if (!guildConns || (!guildConns.primary && !guildConns.secondary)) {
      return interaction.reply({
        content: '❌ I am not in a voice channel in this server.',
        ephemeral: true
      });
    }

    try {
      if (guildConns.primary) {
        guildConns.primary.authorizedDisconnect = true;
        guildConns.primary.connection.destroy();
      }
      if (guildConns.secondary) {
        guildConns.secondary.authorizedDisconnect = true;
        guildConns.secondary.connection.destroy();
      }
      voiceConnections.delete(interaction.guildId);
      await interaction.reply({
        content: '👋 Left the voice channel successfully.',
      });
    } catch (error) {
      console.error('[Voice] Error leaving channel:', error);
      await interaction.reply({
        content: '❌ Failed to leave the voice channel.',
        ephemeral: true
      });
    }
  }
});

// Start the bot
client.login(token);

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
      // Disconnect all voice connections
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


