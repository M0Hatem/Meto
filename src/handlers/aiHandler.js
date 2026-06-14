const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;
let model = null;

function getAIModel() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set in the environment variables.');
    }
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: 'You are Meto (ميتو), a friendly, cool, and helpful Discord assistant. Keep your responses short, natural, engaging, and under 1800 characters to fit within Discord\'s message limits. Use Arabic primarily (with Egyptian/friendly dialect) or match the language of the user. Be helpful, polite, and witty.',
    });
  }
  return model;
}

/**
 * Generates an AI response using Gemini.
 * @param {string} userMessage The cleaned text message from the user
 * @param {string} username The display name or username of the message author
 * @param {object|null} referencedMessage The referenced message object if replying, or null
 * @returns {Promise<string>}
 */
async function generateAIReply(userMessage, username, referencedMessage) {
  try {
    const aiModel = getAIModel();
    
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
    console.log(`[AI] Generating reply for prompt:\n${prompt}`);
    
    const result = await aiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    
    const response = await result.response;
    let text = response.text();
    
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
