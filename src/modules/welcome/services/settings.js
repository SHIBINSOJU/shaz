const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');

/**
 * SINGLE source of truth for welcome configuration. Layers, lowest → highest
 * priority (same layering the whole project already uses):
 *
 *   1. config.yml `welcome:`   — global defaults
 *   2. GuildSettings.welcome   — per-server overrides (written by /setup AND /welcome)
 *   3. draft                   — unsaved /welcome panel edits (preview only, never persisted)
 *
 * The extra switches the /welcome panel exposes are NOT a second configuration
 * system: every one of them maps onto a key the existing WelcomeBuilder already
 * reads, so the panel drives the current renderer instead of replacing it —
 *
 *   message          -> description      (existing placeholder text, existing {user} behaviour)
 *   cardEnabled      -> usernameInCard   (the EXISTING welcome card / GIF compositor)
 *   thumbnailEnabled -> gif.enabled + image.enabled (the message image, never the card)
 *   separatorEnabled -> the existing SeparatorBuilder lines inside the container
 */

// Fields the /welcome panel can stage (draft) and persist (GuildSettings.welcome).
const PANEL_FIELDS = ['enabled', 'channelId', 'message', 'thumbnailEnabled', 'separatorEnabled', 'cardEnabled'];

const MESSAGE_MIN = 1;
const MESSAGE_MAX = 1000;

/** Per-server overrides only — never merged, never throws. */
async function readStoredWelcome(guild) {
    try {
        const settings = await guildSettingsRepository.getGuildSettings(guild.id);
        return settings?.welcome || {};
    } catch {
        return {};
    }
}

/**
 * Layers draft > stored > config.yml and returns the object WelcomeBuilder
 * consumes. `guild.systemChannelId` stays the final channel fallback exactly as
 * before, so an unconfigured server behaves identically to the old code.
 */
function composeWelcomeConfig(base, stored, draft, guild) {
    const value = (field) => {
        if (draft && draft[field] !== undefined) return draft[field];
        if (stored && stored[field] !== undefined && stored[field] !== null) return stored[field];
        return undefined;
    };

    const message = value('message') ?? base.description ?? '';
    const thumbnailEnabled = value('thumbnailEnabled') ?? base.gif?.enabled !== false;
    const cardEnabled = value('cardEnabled') ?? base.usernameInCard !== false;

    const config = {
        ...base,
        enabled: value('enabled') ?? base.enabled ?? true,
        channelId: value('channelId') || base.channelId || guild?.systemChannelId || null,
        welcomeBots: value('welcomeBots') ?? base.welcomeBots ?? false,
        // Panel-facing names, mirrored onto the keys the builder already reads.
        message,
        description: message,
        cardEnabled,
        usernameInCard: cardEnabled,
        thumbnailEnabled,
        separatorEnabled: value('separatorEnabled') ?? base.separatorEnabled !== false
    };

    // Thumbnail = the picture inside the welcome MESSAGE. The card path in
    // WelcomeBuilder is independent of these keys, so turning the thumbnail off
    // never touches the existing welcome card.
    if (base.gif) config.gif = { ...base.gif, enabled: thumbnailEnabled };
    if (base.image) config.image = { ...base.image, enabled: thumbnailEnabled && base.image.enabled !== false };

    return config;
}

/**
 * Resolves effective welcome settings for a guild. Never throws — falls back to
 * file config if the database is down. `draft` is optional, so the event and
 * /testwelcome keep their original single-argument behaviour.
 */
async function resolveWelcomeConfig(guild, draft = null) {
    const base = configService.get('welcome', {}) || {};
    const stored = await readStoredWelcome(guild);
    return composeWelcomeConfig(base, stored, draft, guild);
}

/** Persist panel values into the existing GuildSettings.welcome document. */
async function saveWelcomeSettings(guildId, values = {}) {
    const fields = {};
    for (const field of PANEL_FIELDS) {
        if (values[field] !== undefined) fields[`welcome.${field}`] = values[field];
    }
    if (Object.keys(fields).length === 0) return 0;
    await guildSettingsRepository.updateGuildSettings(guildId, { $set: fields });
    return Object.keys(fields).length;
}

// Breaking @everyone/@here is the only rewrite performed: admin-authored text
// keeps every existing placeholder untouched, since the placeholders system
// (utils/placeholders.js) is still the single place tokens are expanded.
function neutralizePings(text) {
    return text.replace(/@(everyone|here)/gi, '@\u200b$1');
}

function validateWelcomeMessage(raw) {
    const text = String(raw ?? '').trim();
    if (text.length < MESSAGE_MIN) return { ok: false, error: 'The welcome message cannot be empty.' };
    if (text.length > MESSAGE_MAX) {
        return { ok: false, error: `The welcome message is too long (${text.length}/${MESSAGE_MAX} characters).` };
    }
    return { ok: true, value: neutralizePings(text) };
}

function validateWelcomeToggle(field, raw) {
    if (typeof raw !== 'boolean') return { ok: false, error: `Invalid value for ${field}.` };
    return { ok: true, value: raw };
}

module.exports = {
    PANEL_FIELDS,
    MESSAGE_MIN,
    MESSAGE_MAX,
    readStoredWelcome,
    composeWelcomeConfig,
    resolveWelcomeConfig,
    saveWelcomeSettings,
    validateWelcomeMessage,
    validateWelcomeToggle,
    neutralizePings
};
