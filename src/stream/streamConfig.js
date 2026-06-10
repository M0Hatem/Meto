const fs = require('fs');
const path = require('path');

// Path to the persisted per-guild stream config
const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'stream-config.json');

/**
 * Default stream configuration — merged with any per-guild overrides.
 */
const DEFAULTS = {
  enabled: false,
  streamType: 'blank',    // "blank" | "video" | "screen"
  videoPath: null,         // path to .mp4/.webm for video mode (relative to streamAssets/)
  volume: 0,               // audio volume 0-100 (muted by default for blank)
  fps: 30,
  width: 1280,
  height: 720,
  bitrateKbps: 2500
};

/**
 * Load the full config file from disk.
 * Returns an object keyed by guildId.
 */
function _loadAll() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.error('[StreamConfig] Error reading config file:', err.message);
    return {};
  }
}

/**
 * Persist the full config object to disk.
 */
function _saveAll(allConfigs) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(allConfigs, null, 2), 'utf8');
  } catch (err) {
    console.error('[StreamConfig] Error writing config file:', err.message);
  }
}

/**
 * Get the stream config for a specific guild, merged with defaults.
 * @param {string} guildId
 * @returns {object} Merged config
 */
function getStreamConfig(guildId) {
  const all = _loadAll();
  const guildConfig = all[guildId] || {};
  return { ...DEFAULTS, ...guildConfig };
}

/**
 * Update (partial merge) the stream config for a specific guild and persist.
 * @param {string} guildId
 * @param {object} partial - Partial config to merge
 * @returns {object} The new merged config
 */
function setStreamConfig(guildId, partial) {
  const all = _loadAll();
  const existing = all[guildId] || {};
  all[guildId] = { ...existing, ...partial };
  _saveAll(all);
  return { ...DEFAULTS, ...all[guildId] };
}

module.exports = {
  DEFAULTS,
  getStreamConfig,
  setStreamConfig
};
