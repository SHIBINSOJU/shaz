const logger = require('../../../core/logger');
const { resolveAntiLinkConfig } = require('../config');
const { containsLink, isExempt, handleLinkMessage } = require('../services/antiLinkService');

// Lazy require avoids a hard dependency cycle (automod requires antilink
// detection; antilink only asks automod whether it handles links).
function automodHandlesLinks(guild) {
    try {
        const engine = require('../../automod/services/engine');
        return engine.automodHandlesLinks(guild);
    } catch {
        return Promise.resolve(false);
    }
}

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            // Guild messages only — never DMs, bots, or webhooks at this layer
            // (exemptions are re-checked against config in the service).
            if (!message.inGuild()) return;
            if (message.author?.bot) return;
            if (message.webhookId) return;
            if (!message.content) return;

            // Single pipeline: when the AutoMod engine is active and will
            // enforce links for this guild, it handles the message instead —
            // reusing this module's detection, config, and enforcement.
            if (await automodHandlesLinks(message.guild)) return;

            const config = await resolveAntiLinkConfig(message.guild);

            if (!config.enabled) return;
            if (config.disabledChannels.includes(message.channelId)) return;
            if (!containsLink(message.content)) return;

            const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
            if (isExempt(member, message, config)) return;

            await handleLinkMessage(message, config);
        } catch (error) {
            logger.error(`Anti-Link messageCreate failed: ${error.message}`);
        }
    }
};
