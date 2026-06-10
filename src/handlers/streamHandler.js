const { getStreamConfig } = require('../stream/streamConfig');
const { getActiveConnections, isInVC } = require('./voiceHandler');

// ─── Module state ──────────────────────────────────────────────
// One stream per guild: guildId -> { streamer, channelId, startedAt }
const activeStreams = new Map();

// Hardcoded authorized user (matches /leave, /wake, /stopw pattern)
const AUTHORIZED_USER_ID = '476908643711713280';

// ─── Slash command definition ──────────────────────────────────
const streamCommandData = {
  name: 'stream',
  description: 'Start or stop streaming a blank screen in the current voice channel',
  options: [
    {
      name: 'start',
      description: 'Start blank stream',
      type: 1 // SUB_COMMAND
    },
    {
      name: 'stop',
      description: 'Stop streaming',
      type: 1 // SUB_COMMAND
    },
    {
      name: 'status',
      description: 'Check current stream status',
      type: 1 // SUB_COMMAND
    }
  ]
};

// ─── Command handler ───────────────────────────────────────────

/**
 * Handle the /stream slash command (dispatches to subcommands).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleStreamCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'start':
      return handleStart(interaction);
    case 'stop':
      return handleStop(interaction);
    case 'status':
      return handleStatus(interaction);
    default:
      return interaction.reply({ content: '❌ Unknown subcommand.', ephemeral: true });
  }
}

// ─── Subcommand: start ─────────────────────────────────────────
async function handleStart(interaction) {
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

  // Check if secondary client is a self-bot (streamer)
  const streamer = guildConns.secondary.connection;
  const isSelfbot = streamer && typeof streamer.createStream === 'function';
  if (!isSelfbot) {
    return interaction.reply({
      content: '❌ Streaming is not supported because the secondary client is running as a standard bot account. Please configure it with a user account token for streaming.',
      ephemeral: true
    });
  }

  const channelId = guildConns.secondary.channelId;

  // Gate: already streaming
  if (activeStreams.has(guildId)) {
    return interaction.reply({
      content: '❌ Already streaming in this server. Use `/stream stop` first.',
      ephemeral: true
    });
  }

  // Defer reply
  await interaction.deferReply();

  try {
    const config = getStreamConfig(guildId);

    // Create stream connection (Go Live / Screen-Share)
    await streamer.createStream({
      width: config.width || 1280,
      height: config.height || 720,
      fps: config.fps || 30,
      bitrateKbps: config.bitrateKbps || 2500,
      maxBitrateKbps: (config.bitrateKbps || 2500) * 1.5,
      videoCodec: 'H264',
      readAtNativeFps: true,
      hardwareAcceleratedDecoding: false
    });

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
    console.error('[StreamHandler] Failed to start stream:', err);
    await interaction.editReply({
      content: `❌ Failed to start stream: ${err.message}`
    });
  }
}

// ─── Subcommand: stop ──────────────────────────────────────────
async function handleStop(interaction) {
  const guildId = interaction.guildId;

  // Auth gate
  if (interaction.user.id !== AUTHORIZED_USER_ID) {
    return interaction.reply({
      content: `❌ Only the authorized user (<@${AUTHORIZED_USER_ID}>) can use the stream command.`,
      ephemeral: true
    });
  }

  const active = activeStreams.get(guildId);
  if (!active) {
    return interaction.reply({
      content: '❌ No active stream in this server.',
      ephemeral: true
    });
  }

  try {
    if (active.streamer) {
      active.streamer.stopStream();
    }
    activeStreams.delete(guildId);

    await interaction.reply({
      content: '⏹️ Stream stopped.'
    });
  } catch (err) {
    console.error('[StreamHandler] Failed to stop stream:', err);
    await interaction.reply({
      content: `❌ Failed to stop stream: ${err.message}`,
      ephemeral: true
    });
  }
}

// ─── Subcommand: status ────────────────────────────────────────
async function handleStatus(interaction) {
  const guildId = interaction.guildId;
  const active = activeStreams.get(guildId);

  if (!active) {
    return interaction.reply({
      content: '📡 Not streaming in this server.',
      ephemeral: true
    });
  }

  const uptimeMs = Date.now() - active.startedAt;
  const minutes = Math.floor(uptimeMs / 60000);
  const seconds = Math.floor((uptimeMs % 60000) / 1000);
  const uptimeStr = `${minutes}m ${seconds}s`;

  return interaction.reply({
    content: [
      '📡 **Stream Status**',
      `> **Type:** blank`,
      `> **Channel:** <#${active.channelId}>`,
      `> **Uptime:** ${uptimeStr}`
    ].join('\n'),
    ephemeral: true
  });
}

// ─── Cleanup helpers ───────────────────────────────────────────

/**
 * Stop the stream in a specific guild (called when the primary bot leaves VC).
 * @param {string} guildId
 */
function stopStreamForGuild(guildId) {
  const active = activeStreams.get(guildId);
  if (active) {
    console.log(`[StreamHandler] Auto-stopping stream in guild ${guildId} (bot left VC).`);
    try {
      if (active.streamer) {
        active.streamer.stopStream();
      }
    } catch (err) {
      console.error(`[StreamHandler] Error during auto-stop for guild ${guildId}:`, err.message);
    }
    activeStreams.delete(guildId);
  }
}

/**
 * Destroy all active stream clients (called on process shutdown).
 */
function cleanupAllStreams() {
  for (const [guildId, active] of activeStreams.entries()) {
    try {
      if (active.streamer) {
        active.streamer.stopStream();
      }
    } catch (err) {
      console.error(`[StreamHandler] Error stopping stream for guild ${guildId}:`, err.message);
    }
  }
  activeStreams.clear();
}

module.exports = {
  streamCommandData,
  handleStreamCommand,
  stopStreamForGuild,
  cleanupAllStreams
};
