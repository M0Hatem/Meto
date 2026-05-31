require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
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

// Initialize Client with necessary Intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`=========================================`);
  console.log('🤖 Meto Bot is online and ready!');
  console.log(`Logged in as: ${client.user.tag}`);
  console.log(`Configuration: Max File Size = ${MAX_FILE_SIZE_MB}MB`);
  console.log(`=========================================`);
});

client.on('messageCreate', async (message) => {
  // Ignore messages from bots (prevent infinite loops)
  if (message.author.bot) return;

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

