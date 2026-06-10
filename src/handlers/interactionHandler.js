const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { voiceConnections, setupVoiceConnection } = require('./voiceHandler');
const { activeWakes, startWakeLoop, stopWakeLoop } = require('./wakeHandler');
const { handleStreamCommand } = require('./streamHandler');

async function handleInteractionCreate(interaction, client, clientSecondary) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'join') {
    const member = interaction.member;
    if (!member || !member.voice.channel) {
      return interaction.reply({
        content: '❌ You must be in a voice channel to use this command.',
        ephemeral: true
      });
    }

    try {
      // Connect primary bot
      await setupVoiceConnection(client, interaction.guild, member.voice.channel, 'primary');

      // Connect secondary bot if active
      let secondaryJoinedMessage = '';
      if (clientSecondary && clientSecondary.readyAt) {
        await setupVoiceConnection(clientSecondary, interaction.guild, member.voice.channel, 'secondary');
        secondaryJoinedMessage = ` (along with **${clientSecondary.user.username}**)`;
      }

      await interaction.reply({
        content: `🔊 Joined voice channel **${member.voice.channel.name}**${secondaryJoinedMessage}! I will remain here indefinitely.`,
      });
    } catch (error) {
      console.error('[Voice] Error joining channel:', error);
      await interaction.reply({
        content: '❌ Failed to join the voice channel.',
        ephemeral: true
      });
    }
  } else if (commandName === 'leave') {
    const authorizedUserId = '476908643711713280';
    if (interaction.user.id !== authorizedUserId) {
      return interaction.reply({
        content: `❌ Only the authorized user (<@${authorizedUserId}>) is allowed to disconnect the bot.`,
        ephemeral: true
      });
    }

    const guildConns = voiceConnections.get(interaction.guildId);
    if (!guildConns || (!guildConns.primary && !guildConns.secondary)) {
      return interaction.reply({
        content: '❌ I am not in a voice channel in this server.',
        ephemeral: true
      });
    }

    try {
      if (guildConns.primary) {
        guildConns.primary.authorizedDisconnect = true;
        guildConns.primary.connection.destroy();
      }
      if (guildConns.secondary) {
        guildConns.secondary.authorizedDisconnect = true;
        guildConns.secondary.connection.destroy();
      }
      voiceConnections.delete(interaction.guildId);
      await interaction.reply({
        content: '👋 Left the voice channel successfully.',
      });
    } catch (error) {
      console.error('[Voice] Error leaving channel:', error);
      await interaction.reply({
        content: '❌ Failed to leave the voice channel.',
        ephemeral: true
      });
    }
  } else if (commandName === 'wake') {
    const authorizedUserId = '476908643711713280';
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isAuthorized = interaction.user.id === authorizedUserId;

    if (!isAdmin && !isAuthorized) {
      return interaction.reply({
        content: '❌ Only server administrators are allowed to use this command.',
        ephemeral: true
      });
    }

    // Get all users from arguments (up to 5)
    const targets = [];
    for (let i = 1; i <= 5; i++) {
      const user = interaction.options.getUser(`user${i}`);
      if (user) {
        targets.push(user);
      }
    }

    if (targets.length === 0) {
      return interaction.reply({
        content: '❌ You must specify at least one user to wake.',
        ephemeral: true
      });
    }

    const results = [];
    
    // We defer reply because fetching members and voice channels can take a moment
    await interaction.deferReply({ ephemeral: true });

    for (const user of targets) {
      try {
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          results.push(`❌ **${user.username}** could not be found in this server.`);
          continue;
        }

        const voiceState = member.voice;
        if (!voiceState || !voiceState.channelId) {
          results.push(`❌ **${user.username}** is not in a voice channel.`);
          continue;
        }

        const isDeafened = voiceState.selfDeaf;
        const isMuted = voiceState.selfMute;

        // If target is NOT deafened and NOT muted, only authorized user can run force-wake
        const forceWake = !isDeafened && !isMuted;
        if (forceWake && !isAuthorized) {
          results.push(`❌ **${user.username}** is not muted or deafened. Only the authorized user (<@${authorizedUserId}>) can force-wake active users.`);
          continue;
        }

        // Get category channel ID of the current channel
        const currentChannel = voiceState.channel;
        const parentId = currentChannel.parentId;

        // Find alternate voice channel in the same category
        let alternateChannel = null;
        if (parentId) {
          const categoryChannels = interaction.guild.channels.cache.filter(c => 
            c.parentId === parentId && c.id !== currentChannel.id && c.type === ChannelType.GuildVoice
          );
          alternateChannel = categoryChannels.first();
        }

        // Fallback to any other voice channel in the guild if none in same category
        if (!alternateChannel) {
          const guildVoiceChannels = interaction.guild.channels.cache.filter(c => 
            c.id !== currentChannel.id && c.type === ChannelType.GuildVoice
          );
          alternateChannel = guildVoiceChannels.first();
        }

        if (!alternateChannel) {
          results.push(`❌ **${user.username}** cannot be woken because there are no other voice channels in the server to move them to.`);
          continue;
        }

        // Start the wake loop!
        startWakeLoop(client, interaction.guild, member, currentChannel, alternateChannel, forceWake);
        
        if (forceWake) {
          results.push(`🚨 **${user.username}** is being force-woken indefinitely (until stopped by <@${authorizedUserId}>).`);
        } else {
          results.push(`🔊 **${user.username}** is being woken (will stop when they undeafen/unmute/disconnect).`);
        }
      } catch (err) {
        console.error(`Error processing wake for user ${user.username}:`, err);
        results.push(`❌ Failed to start wake loop for **${user.username}**.`);
      }
    }

    await interaction.editReply({
      content: results.join('\n')
    });
  } else if (commandName === 'stopw') {
    const authorizedUserId = '476908643711713280';
    const isAuthorized = interaction.user.id === authorizedUserId;
    const targetUser = interaction.options.getUser('user');

    if (targetUser) {
      // Check if there is an active wake loop for this user
      const wakeState = activeWakes.get(targetUser.id);
      if (!wakeState) {
        return interaction.reply({
          content: `❌ There is no active wake loop for **${targetUser.username}**.`,
          ephemeral: true
        });
      }

      // If it's a force-wake and the caller is not the authorized user, reject
      if (wakeState.forceWake && !isAuthorized) {
        return interaction.reply({
          content: `❌ Only the authorized user (<@${authorizedUserId}>) can stop force-wake loops.`,
          ephemeral: true
        });
      }

      stopWakeLoop(targetUser.id);
      return interaction.reply({
        content: `⏹️ Stopped waking **${targetUser.username}**.`,
        ephemeral: true
      });
    } else {
      // Stop all active wake loops - only allowed for authorized user
      if (!isAuthorized) {
        return interaction.reply({
          content: `❌ Only the authorized user (<@${authorizedUserId}>) is allowed to stop all wake loops.`,
          ephemeral: true
        });
      }

      let count = 0;
      for (const userId of activeWakes.keys()) {
        stopWakeLoop(userId);
        count++;
      }

      return interaction.reply({
        content: `⏹️ Stopped all active wake loops (${count} user(s)).`,
        ephemeral: true
      });
    }
  } else if (commandName === 'stream') {
    await handleStreamCommand(interaction);
  }
}

module.exports = {
  handleInteractionCreate
};
