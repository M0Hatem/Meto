const { AttachmentBuilder } = require('discord.js');
const { detectFacebookLink } = require('../utils/linkDetector');
const { downloadVideo } = require('../utils/videoDownloader');
const { createVideoEmbed } = require('../utils/embedBuilder');
const { sendWebhookMessage } = require('../utils/webhookHandler');

async function handleMessageCreate(message, client, clientSecondary, allowedServers, MAX_FILE_SIZE_MB) {
  // Ignore messages from bots (prevent infinite loops)
  if (message.author.bot) return;

  // --- PEACE TREATY / REMOVE PENALTY COMMAND ---
  // Format: Mention secondary bot + "معاهدة سلام" + Mention one or more users
  if (clientSecondary && clientSecondary.user) {
    const secondaryId = clientSecondary.user.id;
    // Check if the secondary bot is mentioned — either via parsed mentions or raw content
    const isMentionedParsed = message.mentions.users.has(secondaryId);
    const isMentionedRaw = message.content.includes(`<@${secondaryId}>`) || message.content.includes(`<@!${secondaryId}>`);
    const isMentioned = isMentionedParsed || isMentionedRaw;

    console.log(`[PeaceTreaty] Message from ${message.author.id} | secondaryId=${secondaryId} | mentionedParsed=${isMentionedParsed} | mentionedRaw=${isMentionedRaw} | content="${message.content}"`);

    if (isMentioned && message.content.includes('معاهدة سلام')) {
      const isAuthorized = message.author.id === '476908643711713280';
      console.log(`[PeaceTreaty] Peace treaty detected! isAuthorized=${isAuthorized}`);

      if (!isAuthorized) {
        return;
      }

      // Extract mentioned users that are not bots and not the secondary bot itself
      const targetUsers = message.mentions.users.filter(u =>
        u.id !== secondaryId &&
        u.id !== client.user.id &&
        !u.bot
      );

      console.log(`[PeaceTreaty] Target users: ${[...targetUsers.keys()].join(', ')} (count: ${targetUsers.size})`);

      if (targetUsers.size > 0 && message.guild) {
        const { removePenalty } = require('./disconnectPenaltyHandler');
        const targetIds = [...targetUsers.keys()];

        try {
          const cleared = await removePenalty(message.guild, targetIds, client);
          console.log(`[PeaceTreaty] removePenalty returned cleared=${cleared}`);

          const replyText = cleared ? 'استلمت يكبير' : 'مفيش عقوبات تتشال يا غالي';

          // Try sending the reply from the secondary bot
          let replied = false;
          try {
            const secondaryChannel = await clientSecondary.channels.fetch(message.channel.id);
            console.log(`[PeaceTreaty] Secondary channel fetched: ${!!secondaryChannel}`);
            if (secondaryChannel) {
              await secondaryChannel.send(replyText);
              replied = true;
              console.log(`[PeaceTreaty] Secondary bot sent reply successfully.`);
            }
          } catch (secErr) {
            console.error(`[PeaceTreaty] Secondary bot failed to send reply:`, secErr.message);
          }

          // Fallback: if secondary bot couldn't reply, use primary bot
          if (!replied) {
            console.log(`[PeaceTreaty] Falling back to primary bot for reply.`);
            await message.channel.send(replyText).catch(err =>
              console.error('[PeaceTreaty] Primary bot also failed to send reply:', err.message)
            );
          }
        } catch (err) {
          console.error('[PeaceTreaty] Error processing peace treaty:', err.message);
        }
      } else {
        console.log(`[PeaceTreaty] No valid target users found or no guild context.`);
      }
      return; // Do not process FB links or replies for this command message
    }
  }
  // --- END OF PEACE TREATY ---

  // --- AI CHAT FOR SECONDARY BOT ---
  if (clientSecondary && clientSecondary.user) {
    const secondaryId = clientSecondary.user.id;
    const isMentionedParsed = message.mentions.users.has(secondaryId);
    const isMentionedRaw = message.content.includes(`<@${secondaryId}>`) || message.content.includes(`<@!${secondaryId}>`);
    const isMentioned = isMentionedParsed || isMentionedRaw;

    let isReplyToSecondary = false;
    let referencedMessage = null;

    if (message.reference && message.reference.messageId) {
      try {
        referencedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (referencedMessage && referencedMessage.author.id === secondaryId) {
          isReplyToSecondary = true;
        }
      } catch (err) {
        console.error('[AI] Failed to fetch referenced message:', err.message);
      }
    }

    if (isMentioned || isReplyToSecondary) {
      console.log(`[AI] AI prompt triggered by message from ${message.author.tag} (ID: ${message.author.id}) | isMentioned=${isMentioned} | isReply=${isReplyToSecondary}`);
      
      if (!process.env.GEMINI_API_KEY) {
        console.warn('[AI] GEMINI_API_KEY is not set in environment variables.');
        return;
      }

      try {
        const secondaryChannel = await clientSecondary.channels.fetch(message.channel.id).catch(() => null);
        if (secondaryChannel) {
          // Trigger typing status on secondary bot
          await secondaryChannel.sendTyping().catch(() => {});
          
          const { generateAIReply } = require('./aiHandler');
          
          // Clean the message of the secondary bot's mention
          let cleanedContent = message.content.replace(new RegExp(`<@!?${secondaryId}>`, 'g'), '').trim();

          const replyText = await generateAIReply(
            cleanedContent, 
            message.author.displayName || message.author.username, 
            referencedMessage
          );

          if (replyText) {
            let replied = false;
            try {
              const secondaryMsg = await secondaryChannel.messages.fetch(message.id).catch(() => null);
              if (secondaryMsg) {
                await secondaryMsg.reply({ content: replyText });
                replied = true;
              }
            } catch (err) {
              console.warn('[AI] Failed to thread-reply via secondary bot, falling back to channel send:', err.message);
            }

            if (!replied) {
              await secondaryChannel.send({ content: replyText }).catch(err => {
                console.error('[AI] Failed to send message via secondary bot channel:', err.message);
              });
            }
          }
        }
      } catch (err) {
        console.error('[AI] Error in handleMessageCreate AI integration:', err);
      }
      return; // Stop processing further handlers (like FB links) for this message
    }
  }
  // --- END OF AI CHAT FOR SECONDARY BOT ---

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
}

module.exports = {
  handleMessageCreate
};
