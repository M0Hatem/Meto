const { REST, Routes } = require('discord.js');
const { streamCommandData } = require('./streamHandler');

async function registerSlashCommands(clientId, token) {
  const commands = [
    {
      name: 'join',
      description: 'Forces the bot to join your voice channel and persist there indefinitely.'
    },
    {
      name: 'leave',
      description: 'Disconnects the bot from the voice channel (Authorized users only).'
    },
    {
      name: 'wake',
      description: 'Wakes up deafened/muted voice channel members by moving them back and forth.',
      options: [
        {
          name: 'user1',
          description: 'First user to wake',
          type: 6, // USER
          required: true
        },
        {
          name: 'user2',
          description: 'Second user to wake',
          type: 6, // USER
          required: false
        },
        {
          name: 'user3',
          description: 'Third user to wake',
          type: 6, // USER
          required: false
        },
        {
          name: 'user4',
          description: 'Fourth user to wake',
          type: 6, // USER
          required: false
        },
        {
          name: 'user5',
          description: 'Fifth user to wake',
          type: 6, // USER
          required: false
        }
      ]
    },
    {
      name: 'stopw',
      description: 'Stops the wake loop for a specific user or all users.',
      options: [
        {
          name: 'user',
          description: 'Specific user to stop waking (leave empty to stop all)',
          type: 6, // USER
          required: false
        }
      ]
    },
    streamCommandData,
    {
      name: 'bc',
      description: 'Broadcasts a DM to members of a role using the secondary client (Authorized user only).',
      options: [
        {
          name: 'message',
          description: 'The message to send',
          type: 3, // STRING
          required: true
        },
        {
          name: 'target',
          description: 'Target role (@everyone, @here, or Role ID/Name)',
          type: 3, // STRING
          required: true
        },
        {
          name: 'channel',
          description: 'Optional voice/text channel to invite targets to join',
          type: 7, // CHANNEL
          required: false
        }
      ]
    }
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('[Slash Commands] Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
    console.log('[Slash Commands] Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('[Slash Commands] Error registering application commands:', error);
  }
}

module.exports = {
  registerSlashCommands
};
