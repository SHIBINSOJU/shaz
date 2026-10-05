const logger = require('../../../core/logger');
const WelcomeBuilder = require('../services/WelcomeBuilder');
const { resolveWelcomeConfig } = require('../services/settings');
const { withRetry } = require('../../../utils/retry');

module.exports = {
    name: 'guildMemberAdd',
    async execute(member) {
        try {
            const config = await resolveWelcomeConfig(member.guild);
            if (!config.enabled) return;
            if (member.user.bot && config.welcomeBots === false) return;

            const channel = await resolveChannel(member, config.channelId);
            if (!channel) {
                logger.warn(`Welcome: no valid channel for guild ${member.guild.name} (configured: "${config.channelId || 'system channel'}"). Skipping.`);
                return;
            }

            const payload = await WelcomeBuilder.build(member, config);
            await withRetry(() => channel.send(payload));
        } catch (error) {
            logger.error(`Welcome event failed for ${member?.id ?? 'unknown'}: ${error.message}`);
        }
    }
};

async function resolveChannel(member, channelId) {
    if (channelId) {
        const channel = await withRetry(() => member.guild.channels.fetch(channelId), { attempts: 2 }).catch(() => null);
        if (channel && channel.isTextBased() && channel.viewable) return channel;
    }
    const fallback = member.guild.systemChannel;
    if (fallback && fallback.viewable) return fallback;
    return null;
}
