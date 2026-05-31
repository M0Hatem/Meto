/**
 * Regular expressions for various Facebook video formats.
 */
const FB_PATTERNS = [
  // Reels: facebook.com/reel/ID or facebook.com/share/r/ID
  /https?:\/\/(?:www\.)?facebook\.com\/reel\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?facebook\.com\/share\/r\/[a-zA-Z0-9_-]+/i,
  
  // Watch links: facebook.com/watch/?v=ID or fb.watch/ID
  /https?:\/\/(?:www\.)?facebook\.com\/watch\/?\?[a-zA-Z0-9_=&-]+/i,
  /https?:\/\/fb\.watch\/[a-zA-Z0-9_-]+/i,
  
  // Standard video post links: facebook.com/username/videos/ID or facebook.com/watch/live/?v=ID
  /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9.]+\/videos\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?facebook\.com\/watch\/live\/\?[a-zA-Z0-9_=&-]+/i,
  
  // Share video links: facebook.com/share/v/ID
  /https?:\/\/(?:www\.)?facebook\.com\/share\/v\/[a-zA-Z0-9_-]+/i
];

/**
 * Detects if a text message contains a Facebook video or reel URL.
 * @param {string} text - The input text message to scan.
 * @returns {string|null} The matched Facebook video URL, or null if none found.
 */
function detectFacebookLink(text) {
  if (!text || typeof text !== 'string') return null;

  for (const pattern of FB_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

module.exports = {
  detectFacebookLink,
  FB_PATTERNS
};
