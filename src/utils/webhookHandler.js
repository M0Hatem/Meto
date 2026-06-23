const { AttachmentBuilder } = require('discord.js');

/**
 * Gets an existing Meto webhook in the channel, or creates a new one.
 * @param {object} channel - The Discord Channel object.
 * @param {object} clientUser - The client user object of the bot.
 * @returns {Promise<object>} The Webhook instance.
 */
async function getOrCreateWebhook(channel, clientUser) {
  // If it's a thread, the webhook must be created on the parent channel
  const targetChannel = channel.isThread() ? channel.parent : channel;

  if (!targetChannel.fetchWebhooks) {
    throw new Error('This channel type does not support webhooks.');
  }

  // Fetch all webhooks in the channel
  const webhooks = await targetChannel.fetchWebhooks();

  // Find a webhook owned by this bot
  let webhook = webhooks.find(wh => wh.owner.id === clientUser.id);

  if (!webhook) {
    // Create a new webhook
    webhook = await targetChannel.createWebhook({
      name: 'Meto Webhook',
      avatar: clientUser.displayAvatarURL(),
      reason: 'Required for user message impersonation and video embedding'
    });
  }

  return webhook;
}

/**
 * Sends a message via Webhook impersonating a user.
 * @param {object} channel - The Discord Channel object.
 * @param {object} clientUser - The bot client user object.
 * @param {object} author - The original user to impersonate.
 * @param {object} options - Send options (content, files, embeds).
 * @param {string} [replyToMessageId] - Optional message ID to reply to.
 * @returns {Promise<object>} The sent message.
 */
async function sendWebhookMessage(channel, clientUser, author, options, replyToMessageId) {
  const webhook = await getOrCreateWebhook(channel, clientUser);

  const username = author.displayName || author.globalName || author.username;
  const avatarURL = author.displayAvatarURL({ forceStatic: false });

  // If a reply target is specified, use the raw Discord API to include message_reference
  if (replyToMessageId) {
    const queryParams = new URLSearchParams({ wait: 'true' });
    if (channel.isThread()) {
      queryParams.set('thread_id', channel.id);
    }

    const webhookUrl = `https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}?${queryParams}`;

    const payload = {
      username,
      avatar_url: avatarURL,
      message_reference: {
        message_id: replyToMessageId
      },
      allowed_mentions: { replied_user: false }
    };

    if (options.content) {
      payload.content = options.content;
    }

    const rawFiles = options.files || [];

    if (rawFiles.length > 0) {
      // Multipart/form-data upload for files + reply
      payload.attachments = rawFiles.map((f, i) => ({
        id: i,
        filename: f.name || `file_${i}.mp4`
      }));

      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));

      for (let i = 0; i < rawFiles.length; i++) {
        const file = rawFiles[i];
        const blob = new Blob([file.buffer], { type: file.contentType || 'video/mp4' });
        formData.append(`files[${i}]`, blob, file.name || `file_${i}.mp4`);
      }

      const res = await fetch(webhookUrl, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Webhook reply failed (${res.status}): ${errText}`);
      }
      return await res.json();

    } else {
      // JSON-only request (no files)
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Webhook reply failed (${res.status}): ${errText}`);
      }
      return await res.json();
    }
  }

  // Standard webhook send (no reply)
  const sendOptions = {
    username,
    avatarURL,
    files: options.files || [],
    embeds: options.embeds || [],
    content: options.content || undefined
  };

  if (channel.isThread()) {
    sendOptions.threadId = channel.id;
  }

  return await webhook.send(sendOptions);
}

module.exports = {
  getOrCreateWebhook,
  sendWebhookMessage
};
