const logger = require('../../../core/logger');
const { getMinecraftConfig, detectIpQuery, buildIpDirectMessage, checkCooldown, alreadyProcessedMessage } = require('../services/minecraftService');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            if (!message.inGuild()) return;
            if (message.author?.bot) return;
            if (message.webhookId) return;
            if (!message.content) return;

            // One user message -> at most one response, even if the gateway
            // redelivers the same messageCreate event.
            if (alreadyProcessedMessage(message.id)) return;

            const config = getMinecraftConfig();
            if (!config.enabled || !config.ipResponse.enabled) return;

            const query = detectIpQuery(message.content);
            if (!query.matched) return;

            if (!checkCooldown(message.channelId, message.author.id, config.ipResponse.cooldownSeconds)) {
                return;
            }

            // A messageCreate event cannot answer ephemerally, and the IP must
            // never appear in the channel — so NOTHING public is sent here.
            // The full panel (with buttons) is DM'd to the requester instead.
            // DMs are private by nature, so this is the message-triggered
            // equivalent of the ephemeral /serverip reply.
            try {
                await message.author.send(buildIpDirectMessage(config, query.edition));
            } catch (error) {
                if (error?.code === 50007) {
                    // DMs closed: stay silent in the channel (no public panel,
                    // no hint, nothing). Logged so it stays observable.
                    logger.warn(`Minecraft IP DM skipped for ${message.author?.id} (DMs closed, channel ${message.channelId}).`);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            logger.error(`Minecraft messageCreate IP responder failed: ${error.stack || error}`);
        }
    }
};
