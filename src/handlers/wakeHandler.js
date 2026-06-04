// Track active wake loops (userId -> { interval, guild, targetChannelId, alternateChannelId, forceWake, initialSelfDeaf, initialSelfMute })
const activeWakes = new Map();

function runWakeCycle(userId) {
  const wakeState = activeWakes.get(userId);
  if (!wakeState) return;

  const { guild, targetChannelId, alternateChannelId, forceWake, initialSelfDeaf, initialSelfMute } = wakeState;

  // Fetch target member
  guild.members.fetch(userId)
    .then(member => {
      const voiceState = member.voice;

      // 1. Check if they disconnected from voice
      if (!voiceState || !voiceState.channelId) {
        console.log(`[Wake] User ${userId} disconnected from voice. Stopping wake loop.`);
        stopWakeLoop(userId);
        return;
      }

      // 2. Check if they undeafened or unmuted (unless forceWake is active)
      if (!forceWake) {
        if (initialSelfDeaf && !voiceState.selfDeaf) {
          console.log(`[Wake] User ${userId} undeafened. Stopping wake loop.`);
          stopWakeLoop(userId);
          return;
        }
        if (initialSelfMute && !voiceState.selfMute) {
          console.log(`[Wake] User ${userId} unmuted. Stopping wake loop.`);
          stopWakeLoop(userId);
          return;
        }
      }

      // 3. Move them back and forth (500ms cycle)
      const destination = voiceState.channelId === targetChannelId ? alternateChannelId : targetChannelId;
      voiceState.setChannel(destination)
        .catch(err => {
          console.error(`[Wake] Failed to move user ${userId}:`, err.message);
        });
    })
    .catch(err => {
      console.error(`[Wake] Failed to fetch member ${userId}:`, err.message);
      stopWakeLoop(userId);
    });
}

function startWakeLoop(botClient, guild, member, targetChannel, alternateChannel, forceWake) {
  // Clear any existing wake loop first
  stopWakeLoop(member.id);

  const initialSelfDeaf = member.voice.selfDeaf;
  const initialSelfMute = member.voice.selfMute;

  const wakeState = {
    guild,
    targetChannelId: targetChannel.id,
    alternateChannelId: alternateChannel.id,
    forceWake,
    initialSelfDeaf,
    initialSelfMute
  };

  activeWakes.set(member.id, wakeState);

  // Run cycle immediately, then start interval (500ms)
  runWakeCycle(member.id);
  wakeState.interval = setInterval(() => runWakeCycle(member.id), 500);
}

function stopWakeLoop(userId) {
  const wakeState = activeWakes.get(userId);
  if (wakeState) {
    clearInterval(wakeState.interval);
    activeWakes.delete(userId);
    return true;
  }
  return false;
}

function cleanupWakeLoops() {
  for (const userId of activeWakes.keys()) {
    stopWakeLoop(userId);
  }
  activeWakes.clear();
}

module.exports = {
  activeWakes,
  startWakeLoop,
  stopWakeLoop,
  cleanupWakeLoops
};
