const logger = require('../../../core/logger');
const { getMinecraftConfig, detectIpQuery, buildIpPrompt, checkCooldown } = require('../services/minecraftService');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            if (!message.inGuild()) return;
            if (message.author?.bot) return;
            if (message.webhookId) return;
            if (!message.content) return;

            const config = getMinecraftConfig();
            if (!config.enabled || !config.ipResponse.enabled) return;

            const query = detectIpQuery(message.content);
            if (!query.matched) return;

            if (!checkCooldown(message.channelId, message.author.id, config.ipResponse.cooldownSeconds)) {
                return;
            }

            // A messageCreate event cannot answer ephemerally, so the public
            // message only announces the trigger and carries the buttons. The
            // address itself is rendered exclusively by the ephemeral mc:ip:*
            // interaction reply, never in the channel.
            const payload = buildIpPrompt(config, query.edition, message.member?.displayName ?? message.author?.username ?? '');
            await message.reply(payload);
        } catch (error) {
            logger.error(`Minecraft messageCreate IP responder failed: ${error.stack || error}`);
        }
    }
};
