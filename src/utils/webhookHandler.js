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

  const sendOptions = {
    username: author.displayName || author.globalName || author.username,
    avatarURL: author.displayAvatarURL({ forceStatic: false }),
    files: options.files || [],
    embeds: options.embeds || [],
    content: options.content || undefined
  };

  // If the message was sent in a thread, specify the thread ID to route it correctly
  if (channel.isThread()) {
    sendOptions.threadId = channel.id;
  }

  // If a reply target is specified, use the raw Discord API to include message_reference
  if (replyToMessageId) {
    const queryParams = new URLSearchParams({ wait: 'true' });
    if (channel.isThread()) {
      queryParams.set('thread_id', channel.id);
    }

    const body = {
      username: sendOptions.username,
      avatar_url: sendOptions.avatarURL,
      content: sendOptions.content || '',
      message_reference: {
        message_id: replyToMessageId,
        channel_id: channel.id,
        guild_id: channel.guildId
      },
      allowed_mentions: { replied_user: false }
    };

    const res = await fetch(
      `https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}?${queryParams}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Webhook reply failed (${res.status}): ${errText}`);
    }

    return await res.json();
  }

  return await webhook.send(sendOptions);
}

module.exports = {
  getOrCreateWebhook,
  sendWebhookMessage
};
