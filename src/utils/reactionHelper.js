/**
 * Determines a reaction emoji based on message content.
 * @param {string} content - The message content.
 * @returns {string} The chosen emoji.
 */
function getReactionEmoji(content) {
  if (!content) return '👀';
  
  const text = content.toLowerCase();

  // 1. Laughing / Funny
  const laughKeywords = ['😂', '🤣', 'هه', 'lol', 'xd', 'funny', 'ضحك', 'مضحك', 'نكتة'];
  if (laughKeywords.some(keyword => text.includes(keyword))) {
    return '🤣';
  }

  // 2. Roasts / Angry / Insults
  const toxicKeywords = [
    'غبي', 'كلب', 'حمار', 'ياض', 'اهبل', 'عبيط', 'خول',
    'stupid', 'dumb', 'idiot', 'fool', 'trash', 'bad', 'suck',
    'متخلف', 'بارد', 'رخم'
  ];
  if (toxicKeywords.some(keyword => text.includes(keyword))) {
    return '💀';
  }

  // 3. Questioning / Confusion
  const questionKeywords = ['؟', '?', 'ليه', 'مين', 'ازاي', 'فين', 'why', 'how', 'what', 'who', 'confused', 'يا عم'];
  if (questionKeywords.some(keyword => text.includes(keyword))) {
    return '🧐';
  }

  // 4. Positive / Heart / Nice
  const positiveKeywords = [
    'حبيبي', 'يا غالي', 'شكرا', 'جميل', 'كفو', 'احسن',
    'thanks', 'thank you', 'good', 'nice', 'great', 'love', '❤️', '🥰'
  ];
  if (positiveKeywords.some(keyword => text.includes(keyword))) {
    return '❤️';
  }

  // 5. Default/Fallback list to select a funny/sarcastic emoji randomly
  const defaults = ['🤡', '🤫', '👀', '🤖', '🤷‍♂️', '😏'];
  const randomIndex = Math.floor(Math.random() * defaults.length);
  return defaults[randomIndex];
}

module.exports = {
  getReactionEmoji
};
