const configService = require('../../../core/configService');
const afkRepository = require('../../../database/repositories/afkRepository');
const logger = require('../../../core/logger');
const { formatTimestamp } = require('../../utility/services/helpers');

// Suppresses repeat AFK notices for the same AFK user (guild+user -> epoch).
const noticeCooldown = new Map();
const NOTICE_COOLDOWN_MS = 60 * 1000;

function formatAfkDuration(since) {
    const total = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m`;
    if (total < 86400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
    return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`;
}

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            if (!message.inGuild() || message.author?.bot || !message.content) return;
            if (!(configService.get('afk.enabled', true))) return;

            const { guild, author } = message;

            // Author returned: clear AFK silently-ish with a short notice.
            const own = await afkRepository.getAfk(guild.id, author.id);
            if (own) {
                await afkRepository.clearAfk(guild.id, author.id);
                await message.channel.send(`👋 Welcome back, ${author}! Your AFK status was removed.`).catch(() => {});
                return;
            }

            // Mentions of AFK users (deduped, capped lookups).
            const mentioned = message.mentions?.users;
            const ids = [...new Set(mentioned ? [...mentioned.keys()] : [])].slice(0, 5);
            for (const userId of ids) {
                if (userId === author.id) continue;
                const key = `${guild.id}:${userId}`;
                if ((noticeCooldown.get(key) ?? 0) > Date.now()) continue;
                const record = await afkRepository.getAfk(guild.id, userId);
                if (!record) continue;
                noticeCooldown.set(key, Date.now() + NOTICE_COOLDOWN_MS);
                await message.channel.send(
                    `💤 <@${userId}> is AFK: **${record.reason}**\n-# AFK for ${formatAfkDuration(record.timestamp)} (since ${formatTimestamp(record.timestamp)})`
                ).catch(() => {});
            }
        } catch (error) {
            logger.error(`AFK message handler failed: ${error?.message || error}`);
        }
    }
};
