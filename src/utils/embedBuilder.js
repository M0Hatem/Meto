const { EmbedBuilder } = require('discord.js');

/**
 * Creates a premium-looking Discord Embed with Facebook Video information.
 * @param {object} videoInfo - Metadata of the downloaded video.
 * @param {object} author - The Discord User who shared the video.
 * @returns {EmbedBuilder} The built EmbedBuilder instance.
 */
function createVideoEmbed(videoInfo, author) {
  // Curated Discord-friendly color palette (Facebook Blue: #1877F2)
  const embed = new EmbedBuilder()
    .setColor('#1877F2')
    .setTitle(videoInfo.title.length > 250 ? videoInfo.title.substring(0, 250) + '...' : videoInfo.title)
    .setURL(videoInfo.url)
    .setDescription(`🎥 Here is the video so you can watch it directly!`)
    .addFields(
      { name: '⏱️ Duration', value: videoInfo.duration || 'Unknown', inline: true },
      { name: '💾 File Size', value: `${videoInfo.fileSizeMB} MB`, inline: true },
      { name: '👤 Shared By', value: `<@${author.id}>`, inline: true }
    )
    .setFooter({ 
      text: 'Meto • Facebook Reels & Videos',
      iconURL: author.displayAvatarURL({ dynamic: true }) 
    })
    .setTimestamp();

  // If a thumbnail is available, set it
  if (videoInfo.thumbnail) {
    embed.setThumbnail(videoInfo.thumbnail);
  }

  return embed;
}

module.exports = {
  createVideoEmbed
};
