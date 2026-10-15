// Resolves per-guild, per-category logging configuration.
// Priority: MongoDB GuildSettings.logs.<cat> -> config.yml logs.<cat> ->
// built-in defaults. The `moderation` category additionally falls back to
// the legacy moderation.logChannelId / logsEnabled settings so the existing
// /setup modlog-channel keeps working.
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { CATEGORY_KEYS, CATEGORIES } = require('../config');

async function getLogsConfig(guildId) {
    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(guildId);
    } catch {
        db = null;
    }

    const masterEnabled = configService.get('logs.enabled', true);
    const out = {};

    for (const key of CATEGORY_KEYS) {
        const stored = db?.logs?.[key] || {};
        const cfgEnabled = configService.get(`logs.${key}.enabled`, CATEGORIES[key].defaultEnabled);
        const cfgChannel = configService.get(`logs.${key}.channelId`, '');

        let channelId = stored.channelId ?? (cfgChannel || null) ?? null;
        let enabled = stored.enabled ?? cfgEnabled ?? CATEGORIES[key].defaultEnabled;

        // Legacy fallback for the moderation category only.
        if (key === 'moderation') {
            if (!channelId) {
                channelId = db?.moderation?.logChannelId
                    || configService.get('moderation.logs.channelId', '')
                    || null;
            }
            const legacyEnabled = db?.moderation?.logsEnabled ?? configService.get('moderation.logs.enabled', true);
            if (legacyEnabled === false) enabled = false;
        }

        if (!channelId) channelId = null;
        out[key] = { enabled: masterEnabled && enabled !== false, channelId };
    }

    return out;
}

async function getCategoryConfig(guildId, category) {
    const all = await getLogsConfig(guildId);
    return all[category] || { enabled: false, channelId: null };
}

async function setCategoryChannel(guildId, category, channelId) {
    return guildSettingsRepository.updateGuildSettings(guildId, {
        $set: { [`logs.${category}.channelId`]: channelId || null }
    });
}

async function setCategoryEnabled(guildId, category, enabled) {
    return guildSettingsRepository.updateGuildSettings(guildId, {
        $set: { [`logs.${category}.enabled`]: Boolean(enabled) }
    });
}

// Returns every configured log channel id for a guild (used for the
// recursion guard: the bot never logs activity inside its own log channels).
async function getAllLogChannelIds(guildId) {
    const cfg = await getLogsConfig(guildId);
    const ids = new Set();
    for (const key of CATEGORY_KEYS) {
        if (cfg[key]?.channelId) ids.add(String(cfg[key].channelId));
    }
    return ids;
}

module.exports = {
    getLogsConfig,
    getCategoryConfig,
    setCategoryChannel,
    setCategoryEnabled,
    getAllLogChannelIds
};
