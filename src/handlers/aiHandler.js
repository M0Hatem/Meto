const Groq = require('groq-sdk');

let groq = null;

const SYSTEM_PROMPT =
  "You are Meto (ميتو), a friendly, cool, and helpful Discord assistant. " +
  "Keep your responses short, natural, engaging, and under 1800 characters to fit " +
  "within Discord's message limits. Use Arabic primarily (with Egyptian/friendly dialect) " +
  "or match the language of the user. Be helpful, polite, and witty.";

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
 * Generates an AI response using Groq.
 * @param {string} userMessage The cleaned text message from the user
 * @param {string} username The display name or username of the message author
 * @param {object|null} referencedMessage The referenced message object if replying, or null
 * @returns {Promise<string>}
 */
async function generateAIReply(userMessage, username, referencedMessage) {
  try {
    const client = getAIClient();
    
    let promptParts = [];
    const messageText = userMessage ? userMessage.trim() : '';
    
    if (referencedMessage) {
      const refAuthor = referencedMessage.author?.displayName || referencedMessage.author?.username || 'Meto';
      const refContent = referencedMessage.content ? referencedMessage.content.trim() : '(Attachment/Embed)';
      
      promptParts.push(`Here is the conversation context:`);
      promptParts.push(`${refAuthor} said: "${refContent}"`);
      promptParts.push(`${username} replied: "${messageText || '(sent an empty reply or attachment)'}"`);
    } else {
      promptParts.push(`${username} said: "${messageText || '(mentioned you without any text)'}"`);
    }
    
    const prompt = promptParts.join('\n');
    console.log(`[AI] Generating reply for prompt using Groq:\n${prompt}`);
    
    const completion = await callGroqWithRetry(client, {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
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
