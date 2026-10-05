// Anti-Link defaults and effective-config resolution.
//
// Effective settings = config.yml defaults overlaid with per-guild MongoDB
// overrides (GuildSettings.antilink). Never throws — falls back to file
// config when the database is unavailable.
//
// Reserved for future expansion (allowed/blocked domains, invite filtering,
// whitelist/blacklist, escalation): add keys here and merge them the same way.

const configService = require('../../core/configService');
const guildSettingsRepository = require('../../database/repositories/guildSettingsRepository');

const DEFAULTS = {
    enabled: true,
    deleteMessage: true,
    warnUser: true,
    logAction: true,
    warningDeleteDelay: 5000,
    warningCooldown: 10000,
    exempt: {
        administrators: true,
        moderators: false,
        bots: true,
        webhooks: true
    },
    // --- Future expansion (not enforced yet) ---
    allowedDomains: [],
    blockedDomains: [],
    filterDiscordInvitesOnly: false,
    whitelistChannels: [],
    whitelistRoles: []
};

async function resolveAntiLinkConfig(guild) {
    const base = { ...DEFAULTS, ...(configService.get('antilink', {}) || {}) };
    base.exempt = { ...DEFAULTS.exempt, ...(base.exempt || {}) };

    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(guild.id);
    } catch {
        db = null;
    }

    const enabled = db?.antilink?.enabled ?? base.enabled ?? true;
    const disabledChannels = Array.isArray(db?.antilink?.disabledChannels)
        ? db.antilink.disabledChannels
        : [];
    const exemptRoles = Array.isArray(db?.antilink?.exemptRoles)
        ? db.antilink.exemptRoles
        : [];

    return { ...base, enabled, disabledChannels, exemptRoles };
}

function isChannelEnforced(channelId, effectiveConfig) {
    if (!effectiveConfig.enabled) return false;
    return !effectiveConfig.disabledChannels.includes(channelId);
}

module.exports = { DEFAULTS, resolveAntiLinkConfig, isChannelEnforced };
