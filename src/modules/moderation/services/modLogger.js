const logger = require('../../../core/logger');
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { withRetry } = require('../../../utils/retry');

async function resolveLogChannel(guild) {
    if (!configService.get('moderation.logs.enabled', true)) return null;

    let dbSettings = null;
    try {
        dbSettings = await guildSettingsRepository.getGuildSettings(guild.id);
    } catch {
        dbSettings = null;
    }

    if ((dbSettings?.moderation?.logsEnabled ?? true) === false) return null;

    const channelId = dbSettings?.moderation?.logChannelId || configService.get('moderation.logs.channelId', '');
    if (!channelId) return null;

    const channel = await withRetry(() => guild.channels.fetch(channelId), { attempts: 2 }).catch(() => null);
    if (channel && channel.isTextBased() && channel.viewable) return channel;
    return null;
}

/**
 * Sends a Components V2 moderation log entry. Never throws — a logging
 * failure must not break or crash the moderation action itself.
 */
async function logAction(guild, { title, accent, fields, footer }) {
    try {
        const channel = await resolveLogChannel(guild);
        if (!channel) return;
        const payload = buildInfoContainer({ header: title, fields, accent, footer });
        await withRetry(() => channel.send(payload), { attempts: 2 });
    } catch (error) {
        logger.error(`Moderation logging failed: ${error.message}`);
    }
}

module.exports = { logAction, resolveLogChannel };
