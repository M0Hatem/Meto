const { Client } = require('discord.js-selfbot-v13');
const { Streamer } = require('@dank074/discord-video-stream');
const { getStreamConfig } = require('./streamConfig');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

/**
 * StreamClient wraps discord.js-selfbot-v13 + @dank074/Discord-video-stream
 * to push video (or a blank screen) into a Discord voice channel.
 *
 * Usage:
 *   const sc = new StreamClient(token, { ffmpegPath: '/usr/bin/ffmpeg' });
 *   await sc.login();
 *   await sc.startStream(guildId, channelId, config);
 *   // ...
 *   await sc.stopStream();
 *   sc.destroy();
 */
class StreamClient extends EventEmitter {
  /**
   * @param {string} token - Discord **user** token (not a bot token)
   * @param {object} [options]
   * @param {string} [options.ffmpegPath] - Custom path to ffmpeg binary
   * @param {boolean} [options.outputDebug] - Verbose logging from the stream library
   */
  constructor(token, options = {}) {
    super();
    if (!token) throw new Error('StreamClient requires a valid user token.');

    this._token = token;
    this._ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    this._outputDebug = options.outputDebug || false;

    /** @type {Client|null} */
    this._client = null;
    /** @type {Streamer|null} */
    this._streamer = null;

    this._streaming = false;
    this._guildId = null;
    this._channelId = null;
    this._streamStartedAt = null;
    this._currentConfig = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Log the self-bot client into Discord.
   * Resolves once the client is ready.
   */
  async login() {
    return new Promise((resolve, reject) => {
      try {
        this._client = new Client({
          // Minimal intents — just enough to participate in voice
          checkUpdate: false
        });

        this._client.once('ready', () => {
          console.log(`[StreamClient] Self-bot logged in as ${this._client.user.tag}`);
          this._streamer = new Streamer(this._client);
          this.emit('ready');
          resolve();
        });

        this._client.on('error', (err) => {
          console.error('[StreamClient] Client error:', err.message);
          this.emit('error', err);
        });

        this._client.login(this._token).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ─── Streaming ──────────────────────────────────────────────

  /**
   * Join the specified voice channel and begin streaming.
   * @param {string} guildId
   * @param {string} channelId
   * @param {object} config - Stream config (from streamConfig.js or inline)
   */
  async startStream(guildId, channelId, config = {}) {
    if (!this._client || !this._streamer) {
      throw new Error('StreamClient is not logged in. Call login() first.');
    }

    if (this._streaming) {
      throw new Error('Already streaming. Stop the current stream first.');
    }

    const mergedConfig = { ...getStreamConfig(guildId), ...config };
    this._guildId = guildId;
    this._channelId = channelId;
    this._currentConfig = mergedConfig;

    try {
      // Join voice channel via the self-bot
      await this._streamer.joinVoice(guildId, channelId, {
        selfDeaf: false,
        selfMute: true,
        selfVideo: false
      });

      console.log(`[StreamClient] Joined VC ${channelId} in guild ${guildId}`);

      // Start the Go-Live / Screen-Share stream
      const streamConnection = await this._streamer.createStream({
        width: mergedConfig.width || 1280,
        height: mergedConfig.height || 720,
        fps: mergedConfig.fps || 30,
        bitrateKbps: mergedConfig.bitrateKbps || 2500,
        maxBitrateKbps: (mergedConfig.bitrateKbps || 2500) * 1.5,
        videoCodec: 'H264',
        readAtNativeFps: true,
        hardwareAcceleratedDecoding: false
      });

      // Determine what to play based on stream type
      const streamType = mergedConfig.streamType || 'blank';
      let mediaSource;

      switch (streamType) {
        case 'video': {
          const videoPath = this._resolveVideoPath(mergedConfig.videoPath);
          if (!videoPath) {
            throw new Error('No video file specified. Provide a videoPath in the config or use "blank" mode.');
          }
          if (!fs.existsSync(videoPath)) {
            throw new Error(`Video file not found: ${videoPath}`);
          }
          mediaSource = videoPath;
          break;
        }

        case 'screen': {
          // Screen capture is Phase 2 — for now, fall back to blank
          console.warn('[StreamClient] Screen capture mode is not yet implemented. Falling back to blank stream.');
          mediaSource = this._createBlankSource(mergedConfig);
          break;
        }

        case 'blank':
        default: {
          mediaSource = this._createBlankSource(mergedConfig);
          break;
        }
      }

      // Play the media through the stream connection
      const udpConn = this._streamer.voiceConnection;
      if (udpConn) {
        // Use the streamer's built-in playVideo with ffmpeg
        await this._playMedia(mediaSource, mergedConfig);
      }

      this._streaming = true;
      this._streamStartedAt = Date.now();
      console.log(`[StreamClient] Streaming started (type: ${streamType}) in guild ${guildId}`);
      this.emit('streamStart', { guildId, channelId, streamType });
    } catch (err) {
      console.error('[StreamClient] Failed to start stream:', err.message);
      // Cleanup partial state
      await this._safeLeaveVoice();
      throw err;
    }
  }

  /**
   * Stop the current stream and leave the voice channel.
   */
  async stopStream() {
    if (!this._streaming) {
      console.warn('[StreamClient] No active stream to stop.');
      return;
    }

    try {
      // Stop the stream playback
      if (this._streamer) {
        this._streamer.stopStream();
      }
    } catch (err) {
      console.error('[StreamClient] Error stopping stream playback:', err.message);
    }

    await this._safeLeaveVoice();

    const guildId = this._guildId;
    this._streaming = false;
    this._guildId = null;
    this._channelId = null;
    this._streamStartedAt = null;
    this._currentConfig = null;

    console.log(`[StreamClient] Stream stopped in guild ${guildId}`);
    this.emit('streamStop', { guildId });
  }

  /**
   * Hot-swap the video file while streaming.
   * Only works in "video" mode.
   * @param {string} filePath - Path to the new video file
   */
  async setVideoFile(filePath) {
    if (!this._streaming) {
      throw new Error('Not currently streaming.');
    }

    const resolvedPath = this._resolveVideoPath(filePath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error(`Video file not found: ${filePath}`);
    }

    // Stop current playback and restart with new file
    if (this._streamer) {
      this._streamer.stopStream();
    }

    this._currentConfig.streamType = 'video';
    this._currentConfig.videoPath = filePath;

    await this._playMedia(resolvedPath, this._currentConfig);
    console.log(`[StreamClient] Swapped video to: ${resolvedPath}`);
  }

  /**
   * @returns {boolean} Whether the client is currently streaming
   */
  isStreaming() {
    return this._streaming;
  }

  /**
   * Get info about the current stream.
   * @returns {{ guildId: string|null, channelId: string|null, streamType: string|null, startedAt: number|null, uptimeMs: number|null }}
   */
  getStreamInfo() {
    if (!this._streaming) {
      return { guildId: null, channelId: null, streamType: null, startedAt: null, uptimeMs: null };
    }
    return {
      guildId: this._guildId,
      channelId: this._channelId,
      streamType: this._currentConfig?.streamType || null,
      startedAt: this._streamStartedAt,
      uptimeMs: Date.now() - this._streamStartedAt
    };
  }

  /**
   * Full teardown — destroy client and all resources.
   */
  destroy() {
    try {
      if (this._streaming) {
        this.stopStream().catch(() => {});
      }
      if (this._streamer) {
        try { this._streamer.stopStream(); } catch (_) {}
        this._streamer = null;
      }
      if (this._client) {
        this._client.destroy();
        this._client = null;
      }
    } catch (err) {
      console.error('[StreamClient] Error during destroy:', err.message);
    }
    this.removeAllListeners();
    console.log('[StreamClient] Destroyed.');
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Resolve a video path — supports relative paths from streamAssets/
   */
  _resolveVideoPath(videoPath) {
    if (!videoPath) return null;

    // Absolute path
    if (path.isAbsolute(videoPath)) return videoPath;

    // Relative to streamAssets/
    const assetsDir = process.env.STREAM_VIDEO_PATH || path.join(__dirname, 'streamAssets');
    return path.resolve(assetsDir, videoPath);
  }

  /**
   * Create a "blank" media source for the stream.
   * Uses ffmpeg's built-in color source to generate a black screen.
   * Returns an ffmpeg input string.
   */
  _createBlankSource(config) {
    // lavfi color source: generates a solid black frame
    // This is passed directly to ffmpeg as an input
    return `color=c=black:s=${config.width || 1280}x${config.height || 720}:r=${config.fps || 30}`;
  }

  /**
   * Play media through the streamer.
   * @param {string} source - File path or lavfi filter string
   * @param {object} config - Stream config
   */
  async _playMedia(source, config) {
    try {
      const isLavfi = source.startsWith('color=');

      const inputArgs = isLavfi
        ? ['-f', 'lavfi', '-i', source, '-t', '86400']  // 24h max for blank stream
        : ['-stream_loop', '-1', '-i', source];          // loop video indefinitely

      // Use the Streamer's playVideo method which handles ffmpeg internally
      const command = this._streamer.playVideo(source, {
        fps: config.fps || 30,
        width: config.width || 1280,
        height: config.height || 720,
        bitrateKbps: config.bitrateKbps || 2500,
        maxBitrateKbps: (config.bitrateKbps || 2500) * 1.5,
        videoCodec: 'H264',
        readAtNativeFps: true,
        hardwareAcceleratedDecoding: false,
        // For lavfi (blank) source, tell it to use lavfi format
        ...(isLavfi ? { inputFormat: 'lavfi' } : {})
      });

      if (command && typeof command.on === 'function') {
        command.on('error', (err) => {
          console.error('[StreamClient] Playback error:', err.message);
          this.emit('playbackError', err);
        });
      }
    } catch (err) {
      console.error('[StreamClient] Error starting playback:', err.message);
      throw err;
    }
  }

  /**
   * Safely leave voice channel, ignoring errors.
   */
  async _safeLeaveVoice() {
    try {
      if (this._streamer) {
        this._streamer.leaveVoice();
      }
    } catch (err) {
      console.error('[StreamClient] Error leaving voice:', err.message);
    }
  }
}

module.exports = StreamClient;
