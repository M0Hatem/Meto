const { AuditLogEvent } = require('discord.js');

// ─── Constants ─────────────────────────────────────────────────
const PENALTY_CHANNEL_ID = '1222752342227816591';
const AUTHORIZED_USER_ID = '476908643711713280';
const MAX_STRIKES = 3;
const RESET_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── State ─────────────────────────────────────────────────────
// userId -> { strikes: number, tier: number, resetTimer: NodeJS.Timeout|null }
const penaltyData = new Map();



// Per-guild debounce: guildId -> timestamp of last processed penalty (prevents double-counting)
const lastPenaltyTime = new Map();

// State to track audit log entry IDs and counts to handle aggregation
// guildId -> Map(entryId -> count)
const processedAuditLogEntries = new Map();

function getOrCreateData(userId) {
  if (!penaltyData.has(userId)) {
    penaltyData.set(userId, { strikes: 0, tier: 0, resetTimer: null });
  }
  return penaltyData.get(userId);
}

// ─── Audit log lookup ──────────────────────────────────────────

async function initializeAuditLogTracking(primaryClient, secondaryClient) {
  console.log(`[Penalty] initializeAuditLogTracking started. primaryClient: ${!!primaryClient}, secondaryClient: ${!!secondaryClient}`);
  if (!primaryClient || !secondaryClient) return;
  const secondaryUserId = secondaryClient.user?.id;
  console.log(`[Penalty] initializeAuditLogTracking secondaryUserId: ${secondaryUserId}`);
  if (!secondaryUserId) return;

  for (const guild of primaryClient.guilds.cache.values()) {
    console.log(`[Penalty] Initializing tracking for guild ${guild.name} (${guild.id})`);
    try {
      const disconnectLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberDisconnect,
        limit: 10
      }).catch((err) => {
        console.error(`[Penalty] initializeAuditLogTracking fetch MEMBER_DISCONNECT error for ${guild.id}:`, err.message);
        return null;
      });

      const moveLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberMove,
        limit: 10
      }).catch((err) => {
        console.error(`[Penalty] initializeAuditLogTracking fetch MEMBER_MOVE error for ${guild.id}:`, err.message);
        return null;
      });

      const guildMap = new Map();

      if (disconnectLogs) {
        console.log(`[Penalty] Guild ${guild.id} fetched ${disconnectLogs.entries.size} disconnect entries`);
        for (const entry of disconnectLogs.entries.values()) {
          guildMap.set(entry.id, entry.extra?.count || 1);
        }
      }
      if (moveLogs) {
        console.log(`[Penalty] Guild ${guild.id} fetched ${moveLogs.entries.size} move entries`);
        for (const entry of moveLogs.entries.values()) {
          guildMap.set(entry.id, entry.extra?.count || 1);
        }
      }

      processedAuditLogEntries.set(guild.id, guildMap);
      console.log(`[Penalty] Initialized audit log tracking for guild ${guild.name} (${guild.id}). Cached ${guildMap.size} entries.`);
    } catch (err) {
      console.error(`[Penalty] Failed to initialize audit log tracking for guild ${guild.id}:`, err.message);
    }
  }
}

/**
 * Look up who disconnected or moved the bot using the guild audit log.
 * Tracks entry IDs and counts to handle Discord's aggregation behavior.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} primaryClient  - The main bot (has VIEW_AUDIT_LOG)
 * @param {object|null} secondaryClient - The selfbot streamer client
 * @returns {Promise<string|null>} executor user ID, or null
 */
async function findDisconnector(guild, primaryClient, secondaryClient) {
  // Use the primary client's guild instance to ensure proper permissions
  let targetGuild;
  try {
    targetGuild = primaryClient.guilds.cache.get(guild.id) || await primaryClient.guilds.fetch(guild.id);
  } catch {
    targetGuild = guild;
  }

  const secondaryUserId = secondaryClient?.user?.id;
  console.log(`[Penalty] findDisconnector called for guild ${guild.name} (${guild.id}). secondaryUserId: ${secondaryUserId}`);
  if (!secondaryUserId) return null;

  // Helper: skip entries from our own bots
  const isSelf = (id) =>
    id === primaryClient.user.id || id === secondaryUserId;

  let disconnectLogs;
  try {
    disconnectLogs = await targetGuild.fetchAuditLogs({
      type: AuditLogEvent.MemberDisconnect,
      limit: 10
    });
    console.log(`[Penalty] findDisconnector: Fetched ${disconnectLogs?.entries.size || 0} MEMBER_DISCONNECT logs`);
  } catch (err) {
    console.error('[Penalty] Failed to fetch MEMBER_DISCONNECT audit log:', err.message);
  }

  let moveLogs;
  try {
    moveLogs = await targetGuild.fetchAuditLogs({
      type: AuditLogEvent.MemberMove,
      limit: 10
    });
    console.log(`[Penalty] findDisconnector: Fetched ${moveLogs?.entries.size || 0} MEMBER_MOVE logs`);
  } catch (err) {
    console.error('[Penalty] Failed to fetch MEMBER_MOVE audit log:', err.message);
  }

  const entries = [];
  if (disconnectLogs) entries.push(...disconnectLogs.entries.values());
  if (moveLogs) entries.push(...moveLogs.entries.values());

  // Filter entries not executed by our own bots
  const relevantEntries = entries
    .filter(entry => {
      const match = !isSelf(entry.executor?.id);
      console.log(`[Penalty] Entry ID ${entry.id}, Action: ${entry.action}, Executor: ${entry.executor?.id}, isSelf: ${isSelf(entry.executor?.id)}, Matches: ${match}`);
      return match;
    })
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  if (relevantEntries.length === 0) {
    console.log(`[Penalty] [Guild: ${guild.id}] No relevant audit log entries found.`);
    return null;
  }

  if (!processedAuditLogEntries.has(guild.id)) {
    processedAuditLogEntries.set(guild.id, new Map());
  }
  const guildMap = processedAuditLogEntries.get(guild.id);

  let detectedExecutor = null;

  for (const entry of relevantEntries) {
    const entryId = entry.id;
    const currentCount = entry.extra?.count || 1;
    const prevCount = guildMap.get(entryId);
    console.log(`[Penalty] Evaluating Entry ${entryId}: currentCount=${currentCount}, prevCount=${prevCount}`);

    if (prevCount === undefined) {
      // New entry found. If it was created within the last 20 seconds, attribute it.
      guildMap.set(entryId, currentCount);
      const age = Date.now() - entry.createdTimestamp;
      if (age < 20000) {
        console.log(`[Penalty] Found new audit log entry ${entryId} (age: ${age}ms) targeting bot. Executor: ${entry.executor.id}`);
        detectedExecutor = entry.executor.id;
        break; // Stop at the newest matching event
      } else {
        console.log(`[Penalty] Latest audit log entry ${entryId} is too old (age: ${age}ms). Skipping.`);
      }
    } else if (currentCount > prevCount) {
      // Count has increased on an existing entry.
      console.log(`[Penalty] Audit log entry ${entryId} count increased from ${prevCount} to ${currentCount}. Executor: ${entry.executor.id}`);
      guildMap.set(entryId, currentCount);
      detectedExecutor = entry.executor.id;
      break; // Stop at the newest matching event
    }
  }

  // Backfill counts for all other relevant entries we saw to keep our local map in sync
  for (const entry of relevantEntries) {
    const entryId = entry.id;
    const currentCount = entry.extra?.count || 1;
    if (!guildMap.has(entryId)) {
      guildMap.set(entryId, currentCount);
    }
  }

  return detectedExecutor;
}

// ─── Main handler ──────────────────────────────────────────────

/**
 * Called when the secondary (streaming) bot is disconnected or moved by a user.
 * Tracks strikes, sends warning messages, and applies penalties.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} executorId - The user who disconnected/moved the bot
 * @param {object} secondaryClient - Selfbot client (sends messages)
 * @param {import('discord.js').Client} primaryClient - Main bot (applies penalties)
 */
async function handleBotDisconnected(guild, executorId, secondaryClient, primaryClient) {
  if (!executorId) return;
  if (executorId === AUTHORIZED_USER_ID) return;
  if (secondaryClient && executorId === secondaryClient.user?.id) return;
  if (executorId === primaryClient.user.id) return;

  console.log(`[Penalty] User ${executorId} disconnected/moved the streaming bot in guild ${guild.id}`);

  // Debounce: skip if we already processed a penalty for this guild within 4 seconds
  // (prevents double-counting when both voiceStateUpdate AND post-rejoin check fire)
  const now = Date.now();
  const lastTime = lastPenaltyTime.get(guild.id) || 0;
  if (now - lastTime < 4000) {
    console.log(`[Penalty] [Guild: ${guild.id}] Skipping — penalty already processed ${now - lastTime}ms ago.`);
    return;
  }
  lastPenaltyTime.set(guild.id, now);

  const data = getOrCreateData(executorId);

  // Clear existing reset timer
  if (data.resetTimer) {
    clearTimeout(data.resetTimer);
    data.resetTimer = null;
  }

  data.strikes++;

  // Set 5-min reset timer (resets both strikes AND tier)
  data.resetTimer = setTimeout(() => {
    console.log(`[Penalty] Resetting strikes & tier for user ${executorId} (5 min without disconnect).`);
    data.strikes = 0;
    data.tier = 0;
  }, RESET_WINDOW_MS);

  // ── Get the penalty channel (secondary bot sends messages) ──
  let channel;
  try {
    channel =
      secondaryClient.channels.cache.get(PENALTY_CHANNEL_ID) ||
      (await secondaryClient.channels.fetch(PENALTY_CHANNEL_ID));
  } catch {
    // Fallback to primary client
    try {
      channel =
        primaryClient.channels.cache.get(PENALTY_CHANNEL_ID) ||
        (await primaryClient.channels.fetch(PENALTY_CHANNEL_ID));
    } catch (err2) {
      console.error(`[Penalty] Could not access penalty channel ${PENALTY_CHANNEL_ID}:`, err2.message);
      return;
    }
  }

  // ── Strikes < 3 → warning message ──
  if (data.strikes < MAX_STRIKES) {
    const remaining = MAX_STRIKES - data.strikes;
    const nextTier = Math.min(data.tier + 1, 3);
    let tierLabel = '';
    if (nextTier === 1) {
      tierLabel = 'Tier 1 (3-minute timeout 🔇)';
    } else if (nextTier === 2) {
      tierLabel = 'Tier 2 (5-minute timeout 🔇)';
    } else {
      tierLabel = 'Tier 3 (10-minute timeout 🔇)';
    }

    await channel.send(
      `<@${executorId}> خف بضان يحبيبي 🤬\n` +
      `⚠️ Strike **${data.strikes}/${MAX_STRIKES}** — **${remaining}** more and you will face the WRATH!\n` +
      `Next penalty: **${tierLabel}**\n` +
      `Resets in **5 minutes** if you stop doing that.\n` +
      `[.​](https://tenor.com/view/tung-tung-tung-tung-sahur-tung-tung-sahur-tung-tung-tung-sahur-brainrot-baseball-gif-13999381090646842001)`
    ).catch(err => console.error('[Penalty] Failed to send warning:', err.message));

    return;
  }

  // ── 3/3 reached → apply penalty ──
  data.strikes = 0; // reset counter for next cycle
  data.tier = Math.min(data.tier + 1, 3);

  let durationMs = 0;
  let durationLabel = '';
  if (data.tier === 1) {
    durationMs = 3 * 60 * 1000;
    durationLabel = '3-minute';
  } else if (data.tier === 2) {
    durationMs = 5 * 60 * 1000;
    durationLabel = '5-minute';
  } else {
    durationMs = 10 * 60 * 1000;
    durationLabel = '10-minute';
  }

  await channel.send(
    `<@${executorId}> خف بضان يحبيبي 🔇\n` +
    `🔴 **3/3** strikes! **Tier ${data.tier}** penalty ACTIVATED!\n` +
    `Enjoy your **${durationLabel} timeout**! Talk to the hand! 🤫\n` +
    `[.​](https://tenor.com/view/tung-tung-tung-tung-sahur-tung-tung-sahur-tung-tung-tung-sahur-brainrot-baseball-gif-13999381090646842001)`
  ).catch(err => console.error(`[Penalty] Failed to send tier ${data.tier} message:`, err.message));

  await applyTimeoutPenalty(guild, executorId, durationMs, data.tier, primaryClient);
}

// ─── Penalties ─────────────────────────────────────────────────

/**
 * Applies timeout penalty to the offending user.
 */
async function applyTimeoutPenalty(guild, userId, durationMs, tier, primaryClient) {
  try {
    const g = primaryClient.guilds.cache.get(guild.id);
    if (!g) return;
    const member = await g.members.fetch(userId).catch(() => null);
    if (member) {
      await member.timeout(durationMs, `Penalty: Tier ${tier} — timed out for repeatedly disconnecting the bot`);
      console.log(`[Penalty] Tier ${tier}: Timed out ${userId} for ${durationMs / 60000} minutes.`);
    }
  } catch (err) {
    console.error(`[Penalty] Tier ${tier} timeout failed for ${userId}:`, err.message);
  }
}

// ─── Cleanup ───────────────────────────────────────────────────
function cleanupPenalties() {
  for (const [userId, data] of penaltyData.entries()) {
    if (data.resetTimer) clearTimeout(data.resetTimer);
  }
  penaltyData.clear();
}

/**
 * Removes any active penalty or strike data for a set of user IDs in a guild.
 * @param {import('discord.js').Guild} guild
 * @param {string[]} userIds
 * @param {import('discord.js').Client} primaryClient
 * @returns {Promise<boolean>} Whether any penalty was actually cleared
 */
async function removePenalty(guild, userIds, primaryClient) {
  let clearedAny = false;
  for (const userId of userIds) {
    let userCleared = false;

    // 1. Clear penalty tracking data and reset timers
    if (penaltyData.has(userId)) {
      const data = penaltyData.get(userId);
      if (data.strikes > 0 || data.tier > 0 || data.resetTimer) {
        userCleared = true;
      }
      if (data.resetTimer) {
        clearTimeout(data.resetTimer);
      }
      penaltyData.delete(userId);
      console.log(`[Penalty] Cleared strikes/tier data for user ${userId}.`);
    }

    // 2. Remove active timeouts in the guild
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
          await member.timeout(null, 'Penalty removed via peace treaty');
          userCleared = true;
          console.log(`[Penalty] Removed active timeout for user ${userId}.`);
        }
      }
    } catch (err) {
      console.error(`[Penalty] Failed to remove timeout for user ${userId} in guild ${guild.id}:`, err.message);
    }

    if (userCleared) {
      clearedAny = true;
    }
  }
  return clearedAny;
}

module.exports = {
  findDisconnector,
  handleBotDisconnected,
  cleanupPenalties,
  penaltyData,
  lastPenaltyTime,
  initializeAuditLogTracking,
  removePenalty
};

