const { getStreamConfig } = require('../stream/streamConfig');
const { getActiveConnections, isInVC } = require('./voiceHandler');

function withTimeout(promise, timeoutMs, errorMsg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMsg || `Operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isStreamLive(streamer) {
  try {
    return !!(streamer && streamer.voiceConnection && streamer.voiceConnection.streamConnection);
  } catch {
    return false;
  }
}

// ─── Module state ──────────────────────────────────────────────
// One stream per guild: guildId -> { streamer, channelId, startedAt }
const activeStreams = new Map();
// Track guilds currently undergoing stream restart to prevent race conditions
const restartingStreams = new Set();
// Guilds with a restart queued because one was already running when requested
const pendingRestart = new Set();
// Last successful restart time per guild (non-blocking cooldown)
const lastRestartAt = new Map();
const RESTART_COOLDOWN_MS = 15000;

// Hardcoded authorized user (matches /leave, /wake, /stopw pattern)
const AUTHORIZED_USER_ID = '476908643711713280';

// ─── Slash command definition ──────────────────────────────────
const streamCommandData = {
  name: 'stream',
  description: 'Toggle the fake Go Live stream loading screen in the voice channel'
};

// ─── Command handler ───────────────────────────────────────────

/**
 * Handle the /stream slash command (toggles the stream).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleStreamCommand(interaction) {
  const guildId = interaction.guildId;

  // Auth gate
  if (interaction.user.id !== AUTHORIZED_USER_ID) {
    return interaction.reply({
      content: `❌ Only the authorized user (<@${AUTHORIZED_USER_ID}>) can use the stream command.`,
      ephemeral: true
    });
  }

  // Gate: bot must be in VC
  if (!isInVC(guildId)) {
    return interaction.reply({
      content: '❌ Bot is not in a voice channel. Use `/join` first.',
      ephemeral: true
    });
  }

  // Get active voice connections for this guild
  const connections = getActiveConnections();
  const guildConns = connections.get(guildId);
  if (!guildConns || !guildConns.secondary) {
    return interaction.reply({
      content: '❌ Secondary user account bot is not in a voice channel. Use `/join` first.',
      ephemeral: true
    });
  }

  const streamer = guildConns.secondary.connection;
  const isSelfbot = streamer && typeof streamer.createStream === 'function';
  if (!isSelfbot) {
    return interaction.reply({
      content: '❌ Streaming is not supported because the secondary client is running as a standard bot account. Please configure it with a user account token for streaming.',
      ephemeral: true
    });
  }

  const channelId = guildConns.secondary.channelId;

  // If already streaming and live, toggle OFF
  if (activeStreams.has(guildId) && isStreamLive(streamer)) {
    console.log(`[StreamHandler] [Guild: ${guildId}] Received request to toggle stream OFF.`);
    try {
      if (streamer) {
        console.log(`[StreamHandler] [Guild: ${guildId}] Stopping active stream...`);
        streamer.stopStream();
      }
      activeStreams.delete(guildId);
      console.log(`[StreamHandler] [Guild: ${guildId}] Stream stopped and removed from active tracking.`);

      return interaction.reply({
        content: '⏹️ Stream stopped.'
      });
    } catch (err) {
      console.error(`[StreamHandler] [Guild: ${guildId}] Failed to stop stream:`, err);
      return interaction.reply({
        content: `❌ Failed to stop stream: ${err.message}`,
        ephemeral: true
      });
    }
  }

  // If tracked but NOT live, clear stale tracking entry so we can establish a fresh one in one command
  if (activeStreams.has(guildId)) {
    console.log(`[StreamHandler] [Guild: ${guildId}] Stream tracked but not live — clearing stale state to re-establish.`);
    try {
      streamer.stopStream();
    } catch (_) {}
    activeStreams.delete(guildId);
  }

  // Otherwise, toggle ON (Defer reply as Discord API calls take time)
  await interaction.deferReply();
  console.log(`[StreamHandler] [Guild: ${guildId}] Deferring reply to establish stream for channel ${channelId}...`);

  try {
    const config = getStreamConfig(guildId);

    // Create stream connection (Go Live / Screen-Share) and await WebRTC connection
    console.log(`[StreamHandler] [Guild: ${guildId}] Initializing createStream... Config:`, config);
    await withTimeout(
      streamer.createStream({
        width: config.width || 1280,
        height: config.height || 720,
        fps: config.fps || 30,
        bitrateKbps: config.bitrateKbps || 2500,
        maxBitrateKbps: (config.bitrateKbps || 2500) * 1.5,
        videoCodec: 'H264',
        readAtNativeFps: true,
        hardwareAcceleratedDecoding: false
      }),
      15000,
      'createStream call hung'
    );

    console.log(`[StreamHandler] [Guild: ${guildId}] Stream connection established successfully.`);

    // We do NOT call playVideo() to avoid running FFmpeg and consuming bandwidth.
    // This starts the stream indicator (Go Live) in Discord, showing the loading preview indefinitely.
    activeStreams.set(guildId, {
      streamer,
      channelId,
      startedAt: Date.now()
    });

    await interaction.editReply({
      content: `📡 Started stream visual (loading screen, zero bandwidth consumed) in <#${channelId}>.`
    });
  } catch (err) {
    console.error(`[StreamHandler] [Guild: ${guildId}] Failed to start stream during command execution:`, err);
    await interaction.editReply({
      content: `❌ Failed to start stream: ${err.message}`
    });
  }
}

// ─── Cleanup helpers ───────────────────────────────────────────

/**
 * Stop the stream in a specific guild (called when the primary bot leaves VC).
 * @param {string} guildId
 */
function stopStreamForGuild(guildId) {
  const active = activeStreams.get(guildId);
  if (active) {
    console.log(`[StreamHandler] [Guild: ${guildId}] Auto-stopping stream (primary bot left VC).`);
    try {
      if (active.streamer) {
        active.streamer.stopStream();
      }
    } catch (err) {
      console.error(`[StreamHandler] [Guild: ${guildId}] Error during auto-stop stream:`, err.message);
    }
    activeStreams.delete(guildId);
  }
}

/**
 * Destroy all active stream clients (called on process shutdown).
 */
function cleanupAllStreams() {
  console.log('[StreamHandler] Cleaning up all active streams...');
  for (const [guildId, active] of activeStreams.entries()) {
    try {
      if (active.streamer) {
        console.log(`[StreamHandler] [Guild: ${guildId}] Stopping stream client...`);
        active.streamer.stopStream();
      }
    } catch (err) {
      console.error(`[StreamHandler] [Guild: ${guildId}] Error stopping stream during cleanup:`, err.message);
    }
  }
  activeStreams.clear();
  restartingStreams.clear();
}

async function restartStreamIfActive(guildId) {
  const active = activeStreams.get(guildId);
  if (!active || !active.streamer) return;

  // A restart is already running — queue one more pass instead of dropping it.
  // This is the case that broke after the 2nd disconnect.
  if (restartingStreams.has(guildId)) {
    pendingRestart.add(guildId);
    console.log(`[StreamHandler] [Guild: ${guildId}] Restart already running — queued a follow-up restart.`);
    return;
  }

  // Cooldown: skip ONLY if we restarted recently AND the stream is genuinely live.
  // If the stream is dead (e.g. after a move), restart no matter what.
  const last = lastRestartAt.get(guildId) || 0;
  if (Date.now() - last < RESTART_COOLDOWN_MS && isStreamLive(active.streamer)) {
    console.log(`[StreamHandler] [Guild: ${guildId}] Skipping restart — stream is live and within cooldown.`);
    return;
  }

  restartingStreams.add(guildId);
  console.log(`[StreamHandler] [Guild: ${guildId}] Re-establishing stream after voice rejoin...`);

  try {
    const maxRetries = 3;
    let succeeded = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Clear any stale/half-dead stream state before EACH attempt
        try {
          active.streamer.stopStream();
        } catch (_) {}

        // Wait for the voice gateway to settle before re-creating the stream.
        // After a move, Discord needs a moment to finalize the new voice session.
        const delay = attempt === 1 ? 2000 : attempt * 3000;
        console.log(`[StreamHandler] [Guild: ${guildId}] Waiting ${delay}ms before stream re-creation (attempt ${attempt}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));

        const config = getStreamConfig(guildId);
        console.log(`[StreamHandler] [Guild: ${guildId}] Initializing stream re-creation (attempt ${attempt}/${maxRetries})...`);
        await withTimeout(
          active.streamer.createStream({
            width: config.width || 1280,
            height: config.height || 720,
            fps: config.fps || 30,
            bitrateKbps: config.bitrateKbps || 2500,
            maxBitrateKbps: (config.bitrateKbps || 2500) * 1.5,
            videoCodec: 'H264',
            readAtNativeFps: true,
            hardwareAcceleratedDecoding: false
          }),
          15000,
          'createStream call hung'
        );
        console.log(`[StreamHandler] [Guild: ${guildId}] Stream re-established successfully on attempt ${attempt}. ✅`);
        succeeded = true;
        break; // Success — exit retry loop
      } catch (err) {
        const errMsg = err ? (err.message || err) : 'Unknown error';
        console.error(`[StreamHandler] [Guild: ${guildId}] Failed to re-establish stream (attempt ${attempt}/${maxRetries}):`, errMsg);
        if (attempt === maxRetries) {
          console.error(`[StreamHandler] [Guild: ${guildId}] All ${maxRetries} restart attempts failed. Stream may be down until next health check.`);
        }
      }
    }

    if (succeeded) {
      // Non-blocking cooldown — do NOT hold the lock here.
      lastRestartAt.set(guildId, Date.now());
    }
  } finally {
    restartingStreams.delete(guildId);
    console.log(`[StreamHandler] [Guild: ${guildId}] Stream restart state cleared.`);

    // If a move happened while we were busy, run the restart it needed now.
    if (pendingRestart.has(guildId)) {
      pendingRestart.delete(guildId);
      console.log(`[StreamHandler] [Guild: ${guildId}] Running queued follow-up restart...`);
      setImmediate(() => restartStreamIfActive(guildId));
    }
  }
}

module.exports = {
  activeStreams,
  streamCommandData,
  handleStreamCommand,
  stopStreamForGuild,
  cleanupAllStreams,
  restartStreamIfActive
};
