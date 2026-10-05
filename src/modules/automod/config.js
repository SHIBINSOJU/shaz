// AutoMod defaults and effective-config resolution.
//
// Effective settings = config.yml `automod:` defaults overlaid with per-guild
// MongoDB overrides (GuildSettings.autorole-style: GuildSettings.automod).
// Never throws — falls back to file config when the database is unavailable.
//
// Performance: resolved configs are cached in-memory per guild (30s TTL).
// Mutating commands must call invalidateAutomodConfig(guildId). Message
// processing therefore costs zero MongoDB queries in the steady state.

const configService = require('../../core/configService');
const guildSettingsRepository = require('../../database/repositories/guildSettingsRepository');

const CONFIG_TTL_MS = 30 * 1000;
const configCache = new Map(); // guildId -> { config, expiresAt }

const DEFAULTS = {
    enabled: true,
    rules: {
        antiLink: { enabled: true },
        antiInvite: { enabled: true },
        antiSpam: { enabled: true, maxMessages: 5, intervalSeconds: 5, warnCooldownSeconds: 10 },
        antiDuplicate: { enabled: true, maxDuplicates: 3, intervalSeconds: 10 },
        antiMentionSpam: { enabled: true, maxMentions: 5 },
        antiCaps: { enabled: true, minimumLength: 10, percentage: 70 },
        wordFilter: { enabled: true, words: [] },
        antiEveryone: { enabled: true },
        antiRaid: { enabled: true, joins: 5, intervalSeconds: 10, lockdown: false, raidTimeoutMinutes: 10, alertCooldownSeconds: 300 },
        massSpam: { enabled: true, maxMessages: 10, intervalSeconds: 10 }
    },
    actions: {
        deleteMessage: true,
        warnUser: true,
        warnDeleteDelay: 5000,
        timeout: { enabled: false, duration: 300 }
    },
    exemptions: {
        punishAdmins: false,
        roleIds: [],
        channelIds: [],
        userIds: []
    }
};

const RULE_NAMES = [
    'antiLink', 'antiInvite', 'antiSpam', 'antiDuplicate', 'antiMentionSpam',
    'antiCaps', 'wordFilter', 'antiEveryone', 'antiRaid', 'massSpam'
];

function mergeRule(base, override) {
    if (!override || typeof override !== 'object') return { ...base };
    return { ...base, ...override };
}

async function resolveAutomodConfig(guild) {
    const cached = configCache.get(guild.id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;

    const base = { ...DEFAULTS, ...(configService.get('automod', {}) || {}) };
    base.rules = {};
    for (const name of RULE_NAMES) {
        base.rules[name] = mergeRule(
            DEFAULTS.rules[name],
            (configService.get('automod', {}) || {}).rules?.[name]
        );
    }
    base.actions = {
        ...DEFAULTS.actions,
        ...(base.actions || {}),
        timeout: { ...DEFAULTS.actions.timeout, ...((base.actions || {}).timeout || {}) }
    };
    base.exemptions = { ...DEFAULTS.exemptions, ...(base.exemptions || {}) };

    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(guild.id);
    } catch {
        db = null;
    }

    const rules = {};
    for (const name of RULE_NAMES) {
        rules[name] = mergeRule(base.rules[name], db?.automod?.rules?.[name]);
    }

    const words = [
        ...(Array.isArray(base.rules.wordFilter.words) ? base.rules.wordFilter.words : []),
        ...(Array.isArray(db?.automod?.words) ? db.automod.words : [])
    ].map(w => String(w).toLowerCase()).filter(Boolean);
    rules.wordFilter.words = [...new Set(words)];

    const config = {
        enabled: db?.automod?.enabled ?? base.enabled ?? true,
        rules,
        actions: base.actions,
        exemptions: {
            punishAdmins: base.exemptions.punishAdmins ?? false,
            roleIds: Array.isArray(db?.automod?.exemptRoles) ? db.automod.exemptRoles : (base.exemptions.roleIds || []),
            channelIds: Array.isArray(db?.automod?.exemptChannels) ? db.automod.exemptChannels : (base.exemptions.channelIds || []),
            userIds: Array.isArray(db?.automod?.exemptUsers) ? db.automod.exemptUsers : (base.exemptions.userIds || [])
        }
    };

    // DB arrays (even empty) win over file defaults so clearing is permanent.
    if (Array.isArray(db?.automod?.exemptRoles)) config.exemptions.roleIds = db.automod.exemptRoles;
    if (Array.isArray(db?.automod?.exemptChannels)) config.exemptions.channelIds = db.automod.exemptChannels;
    if (Array.isArray(db?.automod?.exemptUsers)) config.exemptions.userIds = db.automod.exemptUsers;

    configCache.set(guild.id, { config, expiresAt: Date.now() + CONFIG_TTL_MS });
    return config;
}

function invalidateAutomodConfig(guildId) {
    configCache.delete(guildId);
}

module.exports = { DEFAULTS, RULE_NAMES, CONFIG_TTL_MS, resolveAutomodConfig, invalidateAutomodConfig };
