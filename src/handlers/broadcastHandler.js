const AUTHORIZED_USER_ID = '476908643711713280';

/**
 * Run the broadcast DM queue.
 */
async function runBroadcast(guild, targetRoleStr, rawMessage, channelOption, clientSecondary, clientPrimary, interaction) {
  let authorizedUser = null;
  try {
    authorizedUser = await clientPrimary.users.fetch(AUTHORIZED_USER_ID);
  } catch (err) {
    console.error('[Broadcast] Could not fetch authorized user for DM updates:', err.message);
  }

  const sendProgressUpdate = async (content) => {
    // 1. Try editing the interaction reply
    try {
      await interaction.editReply({ content });
    } catch (_) {}

    // 2. Also send to the authorized user's DM
    if (authorizedUser) {
      try {
        await authorizedUser.send(`📢 **Broadcast Update:** ${content}`);
      } catch (err) {
        console.error('[Broadcast] Failed to send DM update to authorized user:', err.message);
      }
    }
  };

  // 1. Resolve members
  let members = [];
  try {
    await guild.members.fetch(); // Cache all members
  } catch (err) {
    console.warn('[Broadcast] Failed to fetch all guild members, using cache:', err.message);
  }

  const cleanTarget = targetRoleStr.trim();
  
  if (cleanTarget.toLowerCase() === '@everyone') {
    members = Array.from(guild.members.cache.values());
  } else if (cleanTarget.toLowerCase() === '@here') {
    members = Array.from(guild.members.cache.values()).filter(m => {
      // If client has caching enabled for presences, filter by presence status. Otherwise fallback.
      return m.presence?.status && m.presence.status !== 'offline';
    });
  } else {
    // Resolve role by name, mention, or ID
    let role = guild.roles.cache.find(r => 
      r.id === cleanTarget || 
      r.name === cleanTarget || 
      `<@&${r.id}>` === cleanTarget
    );
    if (!role) {
      // Case insensitive check
      role = guild.roles.cache.find(r => r.name.toLowerCase() === cleanTarget.toLowerCase());
    }
    if (role) {
      members = Array.from(role.members.values());
    } else {
      const errorMsg = `❌ Could not find target role matching "${targetRoleStr}"`;
      await sendProgressUpdate(errorMsg);
      return;
    }
  }

  // Filter out bots and secondary account itself
  members = members.filter(m => !m.user.bot && m.id !== clientSecondary.user.id);

  if (members.length === 0) {
    const errorMsg = '❌ No target members (excluding bots/secondary bot) found to DM.';
    await sendProgressUpdate(errorMsg);
    return;
  }

  // 2. Generate invite link if channel is specified
  let finalMessage = rawMessage;
  if (channelOption) {
    try {
      const targetChannel = guild.channels.cache.get(channelOption.id);
      if (targetChannel) {
        const invite = await targetChannel.createInvite({
          maxAge: 86400, // 24 hours
          maxUses: 0, // unlimited
          reason: 'Invite for broadcast'
        });
        finalMessage += `\n\nJoin the channel here: ${invite.url}`;
      }
    } catch (inviteErr) {
      console.error('[Broadcast] Failed to create channel invite:', inviteErr);
    }
  }

  await sendProgressUpdate(`Starting broadcast to **${members.length}** members using secondary account **${clientSecondary.user.username}**...`);
  console.log(`[Broadcast] Starting broadcast to ${members.length} members using ${clientSecondary.user.username}`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < members.length; i++) {
    // Verify secondary bot is still online and active before sending
    if (!clientSecondary.readyAt) {
      await sendProgressUpdate(`❌ **Broadcast Aborted:** Secondary client disconnected or lost authentication.`);
      return;
    }

    const member = members[i];
    
    try {
      // Fetch user profile on secondary client to open DM channel
      const secondaryUserObj = await clientSecondary.users.fetch(member.id);
      await secondaryUserObj.send(finalMessage);
      successCount++;
      console.log(`[Broadcast] [${i+1}/${members.length}] Successfully sent DM to ${member.user.tag}`);
    } catch (dmErr) {
      failCount++;
      console.error(`[Broadcast] [${i+1}/${members.length}] Failed to send DM to ${member.user.tag}:`, dmErr.message);
      
      // If we hit a rate limit (429), handle it
      if (dmErr.status === 429 || dmErr.code === 50035 || dmErr.message.toLowerCase().includes('rate limit')) {
        const retryAfter = (dmErr.retry_after || 10) * 1000;
        console.warn(`[Broadcast] Rate limited. Waiting ${retryAfter}ms before retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter + 2000));
        // Retry the current user
        i--;
        failCount--;
        continue;
      }
    }

    // Update progress message in Discord every 5 users or at the end
    if ((i + 1) % 5 === 0 || i === members.length - 1) {
      await sendProgressUpdate(`Progress: **${i + 1}/${members.length}** processed.\n✅ Sent: **${successCount}**\n❌ Failed: **${failCount}**`);
    }

    // Anti-detection pauses
    if (i < members.length - 1) {
      let pauseTime;
      if ((i + 1) % 10 === 0) {
        // Long batch pause (20 to 45 seconds) to mimic human rest pattern
        pauseTime = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
        console.log(`[Broadcast] Batch complete. Pausing for ${Math.round(pauseTime / 1000)} seconds...`);
      } else {
        // Standard random delay (4 to 10 seconds)
        pauseTime = Math.floor(Math.random() * (10000 - 4000 + 1) + 4000);
        console.log(`[Broadcast] Pausing for ${Math.round(pauseTime / 1000)} seconds...`);
      }
      await new Promise(resolve => setTimeout(resolve, pauseTime));
    }
  }

  const finalReport = `✅ **Broadcast complete!**\nTotal processed: ${members.length}\nSuccessful DMs: ${successCount}\nFailed DMs (closed DMs or blocked): ${failCount}`;
  await sendProgressUpdate(finalReport);
  console.log(`[Broadcast] Complete. Success: ${successCount}, Fail: ${failCount}`);
}

module.exports = {
  runBroadcast
};
