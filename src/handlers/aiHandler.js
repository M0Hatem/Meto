const Groq = require('groq-sdk');

let clients = null;
let currentClientIndex = 0;
let initialized = false;

const BASE_SYSTEM_PROMPT =
  "You are Meto (ميتو), a sharp-witted, intelligent, and extremely cool Discord assistant who speaks in natural Egyptian Arabic (لهجة مصرية عامية).\n" +
  "Instructions:\n" +
  "1. Speak like a real Egyptian friend: casual, street-smart, and witty. Avoid formal, literal translations, or robotic/overly-polite Arabic.\n" +
  "2. Keep your answers brief, engaging, and to the point (under 1000 characters). Don't give long, boring explanations unless asked.\n" +
  "3. STRICT EMOJI LIMIT: Do not spam emojis. Use at most 1 emoji per message, and only if it really fits. Otherwise, use zero emojis.\n" +
  "4. Output only your direct response. Never start your response with 'ميتو:' or wrap it in quotes.\n" +
  "5. Be smart and actually helpful. If someone is teasing you, be witty; if they need help, give them a smart, direct answer.";

function isAIEnabled() {
  if (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS) {
    return true;
  }
  for (let i = 1; i <= 5; i++) {
    if (process.env[`GROQ_API_KEY_${i}`]) {
      return true;
    }
  }
  return false;
}

function initializeClients() {
  if (initialized) return;

  const keys = [];

  // 1. Check GROQ_API_KEYS (comma separated)
  if (process.env.GROQ_API_KEYS) {
    const splitKeys = process.env.GROQ_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keys.push(...splitKeys);
  }

  // 2. Check individual GROQ_API_KEY
  if (process.env.GROQ_API_KEY) {
    const mainKey = process.env.GROQ_API_KEY.trim();
    if (!keys.includes(mainKey)) {
      keys.push(mainKey);
    }
  }

  // 3. Check GROQ_API_KEY_1, GROQ_API_KEY_2, etc.
  let index = 1;
  while (true) {
    const key = process.env[`GROQ_API_KEY_${index}`];
    if (key) {
      const trimmed = key.trim();
      if (trimmed && !keys.includes(trimmed)) {
        keys.push(trimmed);
      }
      index++;
    } else {
      // Allow gaps up to index + 5 just in case
      let foundMore = false;
      for (let check = 1; check <= 5; check++) {
        const nextKey = process.env[`GROQ_API_KEY_${index + check}`];
        if (nextKey) {
          foundMore = true;
          break;
        }
      }
      if (!foundMore) {
        break;
      }
      index++;
    }
  }

  if (keys.length === 0) {
    throw new Error('No Groq API keys found. Please set GROQ_API_KEY or GROQ_API_KEYS in environment variables.');
  }

  // Deduplicate and initialize Groq clients
  const uniqueKeys = [...new Set(keys)];
  clients = uniqueKeys.map(key => {
    const masked = key.length > 10 ? `${key.substring(0, 7)}...${key.substring(key.length - 4)}` : '***';
    return {
      client: new Groq({ apiKey: key }),
      masked,
      lastRateLimited: 0,
      retryAfter: 0
    };
  });

  console.log(`[AI] Initialized ${clients.length} Groq client(s) for API rotation.`);
  initialized = true;
}

function getAIClient() {
  initializeClients();
  
  const now = Date.now();
  let selectedIdx = currentClientIndex;
  
  for (let i = 0; i < clients.length; i++) {
    const idx = (currentClientIndex + i) % clients.length;
    const clientInfo = clients[idx];
    if (now - clientInfo.lastRateLimited > clientInfo.retryAfter) {
      selectedIdx = idx;
      break;
    }
  }
  
  currentClientIndex = selectedIdx;
  return clients[selectedIdx];
}

/**
 * Robust helper to call Groq API with automatic key failover and backoff retries.
 */
async function callGroqWithRotation(options, maxAttemptsPerClient = 3) {
  initializeClients();

  const numClients = clients.length;
  const totalMaxAttempts = maxAttemptsPerClient * numClients;
  let attempts = 0;
  let triedClientsInCycle = 0;

  while (attempts < totalMaxAttempts) {
    const clientInfo = getAIClient();
    try {
      return await clientInfo.client.chat.completions.create(options);
    } catch (error) {
      attempts++;
      const isRateLimit = error.status === 429 || 
                          (error.message && error.message.includes('429')) || 
                          (error.code && error.code === 'rate_limit_exceeded');

      if (isRateLimit) {
        clientInfo.lastRateLimited = Date.now();
        
        let retryAfterMs = 5000; // default 5 seconds
        if (error.headers && error.headers['retry-after']) {
          const retryAfterSec = parseFloat(error.headers['retry-after']);
          if (!isNaN(retryAfterSec)) {
            retryAfterMs = retryAfterSec * 1000;
          }
        }
        clientInfo.retryAfter = retryAfterMs;

        console.warn(`[AI] Groq client ${clientInfo.masked} rate limited. Retry after ${Math.round(retryAfterMs)}ms.`);

        currentClientIndex = (currentClientIndex + 1) % numClients;

        if (numClients > 1 && triedClientsInCycle < numClients - 1) {
          triedClientsInCycle++;
          console.warn(`[AI] Rotating to next client immediately (client ${currentClientIndex + 1}/${numClients}).`);
          continue;
        }

        if (attempts < totalMaxAttempts) {
          const sleepTime = Math.min(2000, retryAfterMs);
          console.warn(`[AI] All clients rate limited. Waiting ${sleepTime}ms before next attempt...`);
          triedClientsInCycle = 0; // reset cycle
          await new Promise(resolve => setTimeout(resolve, sleepTime));
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  throw new Error('Failed to generate response after trying all available Groq API keys.');
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
    
    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const completion = await callGroqWithRotation({
      model: model,
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
  generateAIReply,
  isAIEnabled
};
