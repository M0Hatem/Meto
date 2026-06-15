const { CustomStatus } = require('discord.js-selfbot-v13');

const songs = [
  // 1. يا بابا سناني واوا (أسناني واوا - طيور الجنة)
  [
    "يا بابا أسناني واوا 🦷",
    "وديني عند الطبيب 🩺",
    "ما عاد بدي شوكولاتة 🍫",
    "بس بدي أشرب الحليب 🥛",
    "السوسة نخرت بسناني 🐛",
    "آه يا سناني آه يا سناني 🥺",
    "صور لي الدكتور سني 📸",
    "فرجاني ست السوسة 🐛",
    "قاعدة جوا مبسوطة 😈",
    "بسيطة يا فسفوسة 😒",
    "والله لأكل تفاح 🍎",
    "ورح أنسى هالحلويات 🍬",
    "ورح أكل خضرة وحليب 🥦🥛",
    "ما بدنا شيبس وغازات 🚫🥤",
    "بالسواك وبالمعجون 🪥",
    "عندي حملة تنظيفات ✨"
  ],
  // 2. شاور شاور (طيور الجنة)
  [
    "شاور شاور يلا يا قمر 🚿",
    "يا عيني على الاستحمام 🧼",
    "بالصابون والمي يا سلام 💦",
    "يا سلام يا سلام نشاط وحيوية ✨",
    "بغسل جسمي بالليفة 🧽",
    "والصابونة الظريفة 🧼",
    "شو أنه منعش كتير 🌊",
    "وحياتي تبقى نظيفة 🌟",
    "شاور شاور يلا يا قمر 🚿",
    "لما يقرب الصابون 🧼",
    "على وشي بغمض العيون 🙈",
    "وبفرك شعري منيح منيح 🧴",
    "ليقبي أحلى ما يكون ✨",
    "شاور شاور يلا يا قمر 🚿",
    "تحممت ويا محلاّني 🛁",
    "أنا هلق صرت شيء ثاني 😎",
    "يلا قولولي نعيماً 💖",
    "عقبالكم يا خلاني 👋"
  ],
  // 3. أنا البندورة الحمرا
  [
    "أنا البندورة الحمرا 🍅",
    "مزروعة بين الخضرا 🌱",
    "تأكل مني تا تشبع 😋",
    "وتصير خدودك حمرا 😊",
    "أنا البندورة الحمرا 🍅",
    "مزروعة بين الخضرا 🌱",
    "تأكل مني تا تشبع 😋",
    "وتصير خدودك حمرا 😊"
  ]
];

let currentSongIndex = 0;
let currentLineIndex = 0;
let lyricInterval = null;

/**
 * Starts rotating the secondary bot's custom status through the kids songs lyrics line-by-line.
 * @param {object} clientSecondary - The secondary Discord client (self-bot).
 */
function startLyricRotation(clientSecondary) {
  if (!clientSecondary || !clientSecondary.isSelfbot) {
    console.warn('[Lyrics] Rotation is only supported when running the secondary client in user self-bot mode.');
    return;
  }

  // Update custom status every 6 seconds for a readable pace
  lyricInterval = setInterval(() => {
    try {
      const currentSong = songs[currentSongIndex];
      const currentLine = currentSong[currentLineIndex];

      const status = new CustomStatus(clientSecondary)
        .setState(currentLine);
        
      clientSecondary.user.setActivity(status);

      currentLineIndex++;
      if (currentLineIndex >= currentSong.length) {
        currentLineIndex = 0;
        currentSongIndex = (currentSongIndex + 1) % songs.length;
      }
    } catch (err) {
      console.error('[Lyrics] Error updating custom status:', err.message);
    }
  }, 6000);

  console.log('[Lyrics] Started automatic kids songs lyrics status rotation.');
}

/**
 * Stops the lyric status rotation interval.
 */
function stopLyricRotation() {
  if (lyricInterval) {
    clearInterval(lyricInterval);
    lyricInterval = null;
    console.log('[Lyrics] Stopped lyric status rotation.');
  }
}

module.exports = {
  startLyricRotation,
  stopLyricRotation
};
