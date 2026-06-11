const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { voiceConnections, setupVoiceConnection } = require('./voiceHandler');
const { activeWakes, startWakeLoop, stopWakeLoop } = require('./wakeHandler');
const { handleStreamCommand } = require('./streamHandler');
const { runBroadcast } = require('./broadcastHandler');

async function handleInteractionCreate(interaction, client, clientSecondary, clientTertiary) {
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

    // Defer the reply since joining (especially for self-bot) can take longer than 3 seconds
    await interaction.deferReply();

    try {
      // Connect primary bot
      await setupVoiceConnection(client, interaction.guild, member.voice.channel, 'primary');

      // Connect secondary bot if active
      let secondaryJoinedMessage = '';
      if (clientSecondary && clientSecondary.readyAt) {
        await setupVoiceConnection(clientSecondary, interaction.guild, member.voice.channel, 'secondary');
        secondaryJoinedMessage = ` (along with **${clientSecondary.user.username}**)`;
      }

      await interaction.editReply({
        content: `🔊 Joined voice channel **${member.voice.channel.name}**${secondaryJoinedMessage}! I will remain here indefinitely.`,
      });
    } catch (error) {
      console.error('[Voice] Error joining channel:', error);
      await interaction.editReply({
        content: '❌ Failed to join the voice channel.',
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

    // Defer reply to prevent Discord API interaction timeout (3 seconds)
    await interaction.deferReply({ ephemeral: true });

    try {
      // Auto-stop stream if active
      try {
        const { stopStreamForGuild } = require('./streamHandler');
        stopStreamForGuild(interaction.guildId);
      } catch (streamErr) {
        console.error('[Voice] Error stopping stream on leave:', streamErr);
      }

      // Disconnect primary bot
      if (guildConns.primary) {
        try {
          guildConns.primary.authorizedDisconnect = true;
          if (guildConns.primary.connection) {
            guildConns.primary.connection.destroy();
          }
        } catch (err) {
          console.error('[Voice] Error destroying primary connection:', err);
        }
      }

      // Disconnect secondary bot (self-bot streamer or normal connection)
      if (guildConns.secondary) {
        try {
          guildConns.secondary.authorizedDisconnect = true;
          const conn = guildConns.secondary.connection;
          if (conn) {
            if (typeof conn.leaveVoice === 'function') {
              conn.leaveVoice();
            } else if (typeof conn.destroy === 'function') {
              conn.destroy();
            }
          }
        } catch (err) {
          console.error('[Voice] Error destroying secondary connection:', err);
        }
      }

      voiceConnections.delete(interaction.guildId);

      await interaction.editReply({
        content: '👋 Left the voice channel successfully.',
      });
    } catch (error) {
      console.error('[Voice] Error leaving channel:', error);
      await interaction.editReply({
        content: '❌ Failed to leave the voice channel.',
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
  } else if (commandName === 'bc') {
    const authorizedUserId = '476908643711713280';
    if (interaction.user.id !== authorizedUserId) {
      return interaction.reply({
        content: `❌ Only the authorized user (<@${authorizedUserId}>) is allowed to use this command.`,
        ephemeral: true
      });
    }

    const senderClient = (clientTertiary && clientTertiary.readyAt) ? clientTertiary : clientSecondary;
    if (!senderClient || !senderClient.readyAt) {
      return interaction.reply({
        content: '❌ No active sending bot client connected (neither tertiary bot nor secondary bot is online).',
        ephemeral: true
      });
    }

    const message = interaction.options.getString('message');
    const target = interaction.options.getString('target');
    const channel = interaction.options.getChannel('channel');

    await interaction.deferReply({ ephemeral: true });

    try {
      runBroadcast(interaction.guild, target, message, channel, senderClient, client, interaction).catch(err => {
        console.error('[Broadcast] Execution error:', err);
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Broadcast failed to start: ${err.message}`
      });
    }
  }
}

module.exports = {
  handleInteractionCreate
};
