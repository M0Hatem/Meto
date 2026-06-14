const Groq = require('groq-sdk');

let groq = null;

const BASE_SYSTEM_PROMPT =
  "You are Meto (ميتو), a cool, witty, and helpful Discord assistant. " +
  "Instructions:\n" +
  "1. Keep your responses short, natural, and under 1800 characters.\n" +
  "2. Respond in a natural Egyptian Arabic dialect (لهجة مصرية عامية) that sounds authentic and friendly. Avoid formal or poorly translated Arabic.\n" +
  "3. Avoid using too many emojis. Use at most 1 or 2 emojis per message, or none at all.\n" +
  "4. Do NOT start your message with your name (like 'ميتو:') or wrap your message in quotation marks. Just output the actual reply text directly.";

function getAIClient() {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set in the environment variables.');
    }
    groq = new Groq({ apiKey });
  }
  return groq;
}

/**
 * Robust helper to call Groq API with retries on rate limits (429 status codes).
 */
async function callGroqWithRetry(client, options, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await client.chat.completions.create(options);
    } catch (error) {
      attempt++;
      const isRateLimit = error.status === 429 || 
                          (error.message && error.message.includes('429')) || 
                          (error.code && error.code === 'rate_limit_exceeded');

      if (isRateLimit && attempt < maxRetries) {
        // Look for retry-after header in seconds, fallback to exponential backoff with jitter
        let retryAfterMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        if (error.headers && error.headers['retry-after']) {
          const retryAfterSec = parseFloat(error.headers['retry-after']);
          if (!isNaN(retryAfterSec)) {
            retryAfterMs = retryAfterSec * 1000;
          }
        }
        console.warn(`[AI] Rate limit hit (429). Retrying attempt ${attempt}/${maxRetries} after ${Math.round(retryAfterMs)}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Clean a string to conform to Groq's name requirement (only alphanumeric, underscores, hyphens, max 64 chars).
 * Appends the user ID to ensure uniqueness.
 */
function sanitizeName(name, userId = '') {
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) {
    cleaned = 'user';
  }
  if (userId) {
    cleaned = `${cleaned}_${userId}`;
  }
  return cleaned.substring(0, 64);
}

/**
 * Generates an AI response using Groq.
 * @param {string} userMessage The cleaned text message from the user
 * @param {string} username The display name or username of the message author
 * @param {object|null} referencedMessage The referenced message object if replying, or null
 * @param {import('discord.js').Message|null} message The full Discord Message object for context
 * @returns {Promise<string>}
 */
async function generateAIReply(userMessage, username, referencedMessage, message) {
  try {
    const client = getAIClient();
    
    // 1. Gather dynamic environment awareness context
    let contextParts = [];
    
    if (message && message.guild) {
      contextParts.push(`Current Server (Guild): "${message.guild.name}" (ID: ${message.guild.id})`);
      contextParts.push(`Current Text Channel: "#${message.channel.name}" (ID: ${message.channel.id})`);
      
      try {
        const { getActiveConnections } = require('./voiceHandler');
        const { activeStreams } = require('./streamHandler');
        const { penaltyData } = require('./disconnectPenaltyHandler');
        
        const guildConns = getActiveConnections().get(message.guild.id);
        const primaryInVoice = guildConns?.primary ? `connected in VC channel <#${guildConns.primary.channelId}>` : 'not in any voice channel';
        const secondaryInVoice = guildConns?.secondary ? `connected in VC channel <#${guildConns.secondary.channelId}>` : 'not in any voice channel';
        
        contextParts.push(`Primary Bot Voice Status: ${primaryInVoice}`);
        contextParts.push(`Secondary Bot Voice Status: ${secondaryInVoice}`);
        
        const isStreaming = activeStreams.has(message.guild.id);
        if (isStreaming) {
          const streamInfo = activeStreams.get(message.guild.id);
          contextParts.push(`Secondary Bot Stream Status: STREAMING (Go Live active, loading screen) in VC <#${streamInfo.channelId}>`);
        } else {
          contextParts.push(`Secondary Bot Stream Status: Not currently streaming.`);
        }
        
        // Sender penalty details
        const senderPenalty = penaltyData.get(message.author.id);
        if (senderPenalty) {
          contextParts.push(`Current speaker (${message.author.username}) penalty profile: ${senderPenalty.strikes} strikes, Tier ${senderPenalty.tier} active penalty.`);
        } else {
          contextParts.push(`Current speaker (${message.author.username}) penalty profile: Clean record (0 strikes, no active penalties).`);
        }
        
        // Sender timeout details
        const timedOut = message.member?.communicationDisabledUntilTimestamp && message.member.communicationDisabledUntilTimestamp > Date.now();
        if (timedOut) {
          const timeLeft = Math.round((message.member.communicationDisabledUntilTimestamp - Date.now()) / 1000);
          contextParts.push(`Current speaker is TIMED OUT (muted) on Discord for another ${timeLeft} seconds.`);
        }
        
        // List other users with active penalty data
        let otherPenalties = [];
        for (const [userId, pData] of penaltyData.entries()) {
          if (userId !== message.author.id && (pData.strikes > 0 || pData.tier > 0)) {
            const member = message.guild.members.cache.get(userId);
            const name = member ? member.user.username : `User ID ${userId}`;
            otherPenalties.push(`${name}: ${pData.strikes} strikes, Tier ${pData.tier}`);
          }
        }
        if (otherPenalties.length > 0) {
          contextParts.push(`Other active user penalties in this server:\n- ${otherPenalties.join('\n- ')}`);
        }
      } catch (err) {
        console.error('[AI] Error gathering voice/penalty context:', err);
      }
    }
    
    // Construct the customized system instruction including awareness context
    let fullSystemPrompt = BASE_SYSTEM_PROMPT;
    if (contextParts.length > 0) {
      fullSystemPrompt += '\n\nHere is your current live Discord runtime context:\n' + contextParts.join('\n');
    }
    
    // 2. Fetch recent message history in the channel to maintain conversation flow
    let chatMessages = [];
    const sanitizedUsername = sanitizeName(username, message ? message.author.id : '');
    const messageText = userMessage ? userMessage.trim() : '';

    if (message && message.channel) {
      try {
        const recentMessages = await message.channel.messages.fetch({ limit: 8 });
        // Filter out current message (to add it explicitly with proper formatting)
        const historyList = [...recentMessages.values()]
          .filter(m => m.id !== message.id)
          .reverse();
          
        for (const msg of historyList) {
          const isMeto = msg.author.id === message.client.user.id || 
                         (message.clientSecondary && msg.author.id === message.clientSecondary.user?.id);
          
          let content = msg.content ? msg.content.trim() : '';
          
          // Remove mentions of the secondary bot from history content
          const secondaryId = message.clientSecondary?.user?.id;
          if (secondaryId) {
            content = content.replace(new RegExp(`<@!?${secondaryId}>`, 'g'), '').trim();
          }
          
          if (isMeto) {
            chatMessages.push({
              role: 'assistant',
              content: content || '(sent a video/embed/file)'
            });
          } else {
            const authorName = msg.author.displayName || msg.author.username;
            chatMessages.push({
              role: 'user',
              name: sanitizeName(authorName, msg.author.id),
              content: content || '(sent an attachment/embed)'
            });
          }
        }
      } catch (err) {
        console.error('[AI] Failed to fetch channel conversation history:', err);
      }
    }

    // 3. Handle context of referenced message (replies) if not present in history
    let finalContent = messageText || '(mentioned you)';
    if (referencedMessage) {
      const refAuthor = referencedMessage.author?.displayName || referencedMessage.author?.username || 'User';
      const refContent = referencedMessage.content ? referencedMessage.content.trim() : '(Attachment/Embed)';
      finalContent = `[Replying to ${refAuthor}'s message: "${refContent}"]\n${finalContent}`;
    }
    
    // Add current user prompt as final message
    chatMessages.push({
      role: 'user',
      name: sanitizedUsername,
      content: finalContent
    });

    console.log(`[AI] Generating reply for ${username} in server: ${message?.guild?.name || 'DM'}`);
    
    const completion = await callGroqWithRetry(client, {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: fullSystemPrompt },
        ...chatMessages
      ],
      max_tokens: 1024,
      temperature: 0.8,
    });
    
    let text = completion.choices[0]?.message?.content;
    
    if (!text) {
      return 'لم أستطع فهم ذلك، هل يمكنك توضيح السؤال؟';
    }
    
    // Safety check for length
    if (text.length > 2000) {
      text = text.substring(0, 1990) + '...';
    }
    
    return text;
  } catch (error) {
    console.error('[AI] Error generating AI response:', error);
    throw error;
  }
}

module.exports = {
  generateAIReply
};
