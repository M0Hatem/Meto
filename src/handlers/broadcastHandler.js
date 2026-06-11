const AUTHORIZED_USER_ID = '476908643711713280';

function formatProgressBar(success, fail, total, statusText) {
  const processed = success + fail;
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
  const totalBlocks = 15;
  const filledBlocks = total > 0 ? Math.round((processed / total) * totalBlocks) : 0;
  const emptyBlocks = totalBlocks - filledBlocks;
  const bar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  return `📊 **Broadcast Status**
\`[${bar}]\` **${percentage}%** (${processed}/${total})

✅ **Sent:** \`${success}\`
❌ **Failed:** \`${fail}\`
⏳ **Remaining:** \`${total - processed}\`
📡 **Current Activity:** ${statusText}`;
}

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
        await authorizedUser.send(`📢 **Broadcast Update:**\n${content}`);
      } catch (err) {
        console.error('[Broadcast] Failed to send DM update to authorized user:', err.message);
      }
    }
  };

  // Instantly resolve the "Meto is thinking..." state by sending an initial progress message
  await sendProgressUpdate(formatProgressBar(0, 0, 0, '🔍 Resolving target roles/users and caching guild members...'));

  // 1. Cache all guild members first so we can query them reliably
  try {
    await guild.members.fetch();
  } catch (err) {
    console.warn('[Broadcast] Failed to fetch all guild members, using cache:', err.message);
  }

  // 2. Parse targets
  const targets = [];
  let match;

  // Find role mentions: <@&ID>
  const roleMentionRegex = /<@&([0-9]+)>/g;
  while ((match = roleMentionRegex.exec(targetRoleStr)) !== null) {
    targets.push({ type: 'role_id', value: match[1] });
  }

  // Find user mentions: <@ID> or <@!ID>
  const userMentionRegex = /<@!?([0-9]+)>/g;
  while ((match = userMentionRegex.exec(targetRoleStr)) !== null) {
    targets.push({ type: 'user_id', value: match[1] });
  }

  // If no markdown mentions were extracted, check for raw text targets
  if (targets.length === 0) {
    if (targetRoleStr.toLowerCase().includes('@everyone')) {
      targets.push({ type: 'everyone' });
    } else if (targetRoleStr.toLowerCase().includes('@here')) {
      targets.push({ type: 'here' });
    } else {
      // Split by commas, or if multiple @ symbols are present and no commas, split by @
      let parts = [];
      if (targetRoleStr.includes('@') && !targetRoleStr.includes(',')) {
        parts = targetRoleStr.split('@').map(p => p.trim()).filter(p => p.length > 0);
      } else {
        parts = targetRoleStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
      }

      for (const part of parts) {
        const cleanPart = part.startsWith('@') ? part.substring(1).trim() : part;
        if (cleanPart.length > 0) {
          targets.push({ type: 'name_or_id', value: cleanPart });
        }
      }
    }
  }

  // 3. Resolve members based on targets list
  const resolvedMembers = new Set();

  for (const target of targets) {
    if (target.type === 'everyone') {
      guild.members.cache.forEach(m => resolvedMembers.add(m));
    } else if (target.type === 'here') {
      guild.members.cache.forEach(m => {
        if (m.presence?.status && m.presence.status !== 'offline') {
          resolvedMembers.add(m);
        }
      });
    } else if (target.type === 'user_id') {
      const member = guild.members.cache.get(target.value);
      if (member) resolvedMembers.add(member);
    } else if (target.type === 'role_id') {
      const role = guild.roles.cache.get(target.value);
      if (role) {
        role.members.forEach(m => resolvedMembers.add(m));
      }
    } else if (target.type === 'name_or_id') {
      // Check if it's a role ID
      let role = guild.roles.cache.get(target.value);
      // Try resolving role by name (case-insensitive)
      if (!role) {
        role = guild.roles.cache.find(r => r.name.toLowerCase() === target.value.toLowerCase());
      }

      if (role) {
        role.members.forEach(m => resolvedMembers.add(m));
      } else {
        // Try checking if it's a user ID or username
        const member = guild.members.cache.get(target.value) || 
                       guild.members.cache.find(m => m.user.username.toLowerCase() === target.value.toLowerCase());
        if (member) {
          resolvedMembers.add(member);
        } else {
          console.warn(`[Broadcast] Could not resolve target: "${target.value}"`);
        }
      }
    }
  }

  // Filter out bots and secondary account itself
  let members = Array.from(resolvedMembers).filter(m => !m.user.bot && m.id !== clientSecondary.user.id);

  if (members.length === 0) {
    const errorMsg = `❌ Could not resolve any target members from input: "${targetRoleStr}"`;
    await sendProgressUpdate(errorMsg);
    return;
  }

  // 4. Generate invite link if channel is specified
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

  await sendProgressUpdate(formatProgressBar(0, 0, members.length, `🚀 Starting queue (using account **${clientSecondary.user.username}**)...`));
  console.log(`[Broadcast] Starting broadcast to ${members.length} members using ${clientSecondary.user.username}`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < members.length; i++) {
    // Verify secondary bot is still online and active before sending
    if (!clientSecondary.readyAt) {
      await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, `❌ **Broadcast Aborted:** Secondary client disconnected.`));
      return;
    }

    const member = members[i];
    
    // Update status to preparing DM
    await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, `✉️ Sending message to **${member.user.tag}**...`));

    let resultStatus = '';
    try {
      // Fetch user profile on secondary client to open DM channel
      const secondaryUserObj = await clientSecondary.users.fetch(member.id);
      await secondaryUserObj.send(finalMessage);
      successCount++;
      resultStatus = `✅ Sent message to **${member.user.tag}**.`;
      console.log(`[Broadcast] [${i+1}/${members.length}] Successfully sent DM to ${member.user.tag}`);
    } catch (dmErr) {
      // If we hit a rate limit (429), handle it
      if (dmErr.status === 429 || dmErr.code === 50035 || dmErr.message.toLowerCase().includes('rate limit')) {
        const retryAfter = (dmErr.retry_after || 10);
        console.warn(`[Broadcast] Rate limited. Waiting ${retryAfter}s before retrying...`);
        
        await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, `🚨 **Rate Limited!** Waiting \`${retryAfter}s\` before retrying user...`));
        
        await new Promise(resolve => setTimeout(resolve, (retryAfter * 1000) + 2000));
        // Retry the current user
        i--;
        continue;
      }

      failCount++;
      resultStatus = `❌ Failed to DM **${member.user.tag}** (${dmErr.message}).`;
      console.error(`[Broadcast] [${i+1}/${members.length}] Failed to send DM to ${member.user.tag}:`, dmErr.message);
    }

    // Update progress message in Discord with the correct outcome of the DM send
    await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, resultStatus));

    // Anti-detection pauses
    if (i < members.length - 1) {
      let pauseTime;
      let statusText = '';
      if ((i + 1) % 10 === 0) {
        // Long batch pause (20 to 45 seconds) to mimic human rest pattern
        pauseTime = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
        const sec = Math.round(pauseTime / 1000);
        statusText = `💤 Batch pause for \`${sec}s\` to avoid bans...`;
        console.log(`[Broadcast] Batch complete. Pausing for ${sec} seconds...`);
      } else {
        // Standard random delay (4 to 10 seconds)
        pauseTime = Math.floor(Math.random() * (10000 - 4000 + 1) + 4000);
        const sec = Math.round(pauseTime / 1000);
        statusText = `⏳ Randomized delay (pausing for \`${sec}s\`)...`;
        console.log(`[Broadcast] Pausing for ${sec} seconds...`);
      }
      
      await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, statusText));
      await new Promise(resolve => setTimeout(resolve, pauseTime));
    }
  }

  const finalReportText = `🎉 **Complete!** Successfully sent to \`${successCount}\` user(s). Failed: \`${failCount}\`.`;
  await sendProgressUpdate(formatProgressBar(successCount, failCount, members.length, finalReportText));
  console.log(`[Broadcast] Complete. Success: ${successCount}, Fail: ${failCount}`);
}

module.exports = {
  runBroadcast
};
