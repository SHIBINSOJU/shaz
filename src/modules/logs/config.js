const { BRAND_RED } = require('../../utils/brandColor');
// Canonical log categories. Single source of truth for commands,
// components, config resolution and the dispatcher.
const CATEGORIES = {
    member: {
        key: 'member',
        label: 'Member Logs',
        emoji: '👥',
        description: 'Joins, leaves, kicks, bans, timeouts, nicknames, roles',
        accent: 0x57F287,
        defaultEnabled: true
    },
    message: {
        key: 'message',
        label: 'Message Logs',
        emoji: '💬',
        description: 'Deletes, edits, bulk deletes, pins, threads',
        accent: 0xFEE75C,
        defaultEnabled: true
    },
    voice: {
        key: 'voice',
        label: 'Voice Logs',
        emoji: '🔊',
        description: 'Join, leave, move, mute, deafen, video, streaming',
        accent: BRAND_RED,
        defaultEnabled: true
    },
    channel: {
        key: 'channel',
        label: 'Channel Logs',
        emoji: '📺',
        description: 'Channel create, delete and setting changes',
        accent: 0x00AFF4,
        defaultEnabled: true
    },
    role: {
        key: 'role',
        label: 'Role Logs',
        emoji: '🎭',
        description: 'Role create, delete and setting changes',
        accent: 0xEB459E,
        defaultEnabled: true
    },
    moderation: {
        key: 'moderation',
        label: 'Moderation Logs',
        emoji: '🔨',
        description: 'Bans, unbans, timeouts and kicks',
        accent: 0xED4245,
        defaultEnabled: true
    },
    server: {
        key: 'server',
        label: 'Server Logs',
        emoji: '⚙️',
        description: 'Server settings, emojis, stickers, events, webhooks',
        accent: 0x95A5A6,
        defaultEnabled: true
    },
    invite: {
        key: 'invite',
        label: 'Invite Logs',
        emoji: '📨',
        description: 'Invite created and deleted',
        accent: 0xF47FFF,
        defaultEnabled: true
    }
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function isValidCategory(key) {
    return Object.prototype.hasOwnProperty.call(CATEGORIES, key);
}

module.exports = { CATEGORIES, CATEGORY_KEYS, isValidCategory };
