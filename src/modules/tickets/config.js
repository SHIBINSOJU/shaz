// Effective ticket configuration: config.yml defaults overlaid with
// per-guild MongoDB overrides (GuildSettings.tickets). Categories stay
// file-based (documented as the advanced path). Never throws.

const configService = require('../../core/configService');
const guildSettingsRepository = require('../../database/repositories/guildSettingsRepository');

const DEFAULT_CATEGORIES = {
    general: {
        name: 'General Support',
        description: 'Get help with general questions',
        emoji: '🎫',
        categoryId: '',
        staffRoleIds: []
    },
    bug: {
        name: 'Player / Bug Report',
        description: 'Report a player or server bug',
        emoji: '🎫',
        categoryId: '',
        staffRoleIds: []
    },
    purchase: {
        name: 'Purchase / Donation Support',
        description: 'Get help with purchases or donations',
        emoji: '🎫',
        categoryId: '',
        staffRoleIds: []
    }
};

function coerceIdList(value) {
    // Accept a proper YAML list, a single bare string ID, or nothing.
    // Discord IDs always stay strings — never convert to numbers.
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return items
        .filter((id) => id !== null && id !== undefined && String(id).trim() !== '')
        .map((id) => String(id).trim());
}

function normalizeCategories(raw) {
    const source = raw && typeof raw === 'object' ? raw : DEFAULT_CATEGORIES;
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== 'object') continue;
        out[key] = {
            name: value.name || key,
            description: value.description || '',
            emoji: value.emoji || '🎫',
            // String() guards against unquoted YAML numbers, which lose
            // precision beyond 2^53 and would corrupt the snowflake.
            categoryId: value.categoryId ? String(value.categoryId) : '',
            staffRoleIds: coerceIdList(value.staffRoleIds),
            accent: value.accent || null,
            welcomeMessage: value.welcomeMessage || ''
        };
    }
    return Object.keys(out).length > 0 ? out : { ...DEFAULT_CATEGORIES };
}

async function resolveTicketsConfig(guild) {
    const base = configService.get('tickets', {}) || {};

    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(guild.id);
    } catch {
        db = null;
    }

    const panel = base.panel || {};
    const logs = base.logs || {};
    const naming = base.naming || {};
    const close = base.close || {};

    return {
        enabled: base.enabled ?? true,
        panel: {
            channelId: db?.tickets?.panelChannelId ?? panel.channelId ?? '',
            title: panel.title || '🎫 Support Center',
            description: panel.description || 'Need help? Select a category below.\nOur staff will assist you shortly.'
        },
        logs: {
            enabled: (db?.tickets?.logsEnabled ?? logs.enabled ?? true) === true,
            channelId: db?.tickets?.logChannelId ?? logs.channelId ?? ''
        },
        maxOpenTicketsPerUser: db?.tickets?.maxOpenTicketsPerUser ?? base.maxOpenTicketsPerUser ?? 1,
        allowReclaim: base.allowReclaim ?? false,
        creatorCanClose: base.creatorCanClose ?? true,
        creationCooldownMs: base.creationCooldownMs ?? 30000,
        // Optional global support role mentioned in the welcome message
        // alongside per-category staff roles. String ID, "" = none.
        // When unset, only per-category staffRoleIds are mentioned;
        // when nothing is configured, no role is mentioned at all.
        supportRoleId: String(
            db?.tickets?.supportRoleId ?? base.support_role_id ?? base.supportRoleId ?? ''
        ).trim(),
        naming: {
            format: naming.format || 'ticket-{number}'
        },
        close: {
            deleteImmediately: db?.tickets?.deleteImmediately ?? close.deleteImmediately ?? false,
            deleteDelayMs: close.deleteDelayMs ?? 10000,
            closedCategoryId: db?.tickets?.closedCategoryId ?? close.closedCategoryId ?? '',
            lockOnClose: close.lockOnClose ?? true
        },
        categories: normalizeCategories(base.categories)
    };
}

function getCategory(config, key) {
    return config?.categories?.[key] || null;
}

module.exports = { DEFAULT_CATEGORIES, normalizeCategories, coerceIdList, resolveTicketsConfig, getCategory };
