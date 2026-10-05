const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');

async function fail(interaction, where, error, message = '❌ Something went wrong. Please try again.') {
    logger.error(`${where} failed: ${error?.stack || error}`);
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: message });
        } else {
            await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    } catch {
        // Response window closed.
    }
}

function formatTimestamp(date) {
    if (!date) return 'Unknown';
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    return `<t:${Math.floor(d.getTime() / 1000)}:F>`;
}

function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
}

// Best-effort member census. Falls back to cache when a full fetch fails.
async function countMembers(guild) {
    let members = guild.members.cache;
    try {
        if (members.size === 0 || guild.memberCount > members.size) {
            members = await guild.members.fetch();
        }
    } catch {
        members = guild.members.cache;
    }
    let bots = 0;
    for (const member of members.values()) {
        if (member.user?.bot) bots++;
    }
    const total = guild.memberCount ?? members.size;
    return { total, bots, humans: Math.max(0, total - bots) };
}

module.exports = { fail, formatTimestamp, formatDuration, countMembers };
