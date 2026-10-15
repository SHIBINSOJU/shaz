// Effective configuration for the YouTube promotion system.
//
// Layering (first non-empty value wins, matching the project's config
// philosophy — file defaults, per-guild MongoDB overrides on top):
//   enabled / channelId / allowedRoleId:
//     GuildSettings.youtubePromotion -> config.yml youtube_promotion
//   cooldowns / fallback API key: config.yml youtube_promotion
//   API key: YOUTUBE_API_KEY env var -> config.yml youtube_api_key

const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');

const DEFAULTS = {
    enabled: true,
    cooldownSeconds: 300,
    duplicateCooldownSeconds: 1800
};

// Custom RISE SMP banner (branding artwork). Centrally managed via
// `youtube_promotion.banner_url` (or per-guild `youtubePromotion.bannerUrl`);
// this constant is only the fallback when neither is set.
const DEFAULT_BANNER_URL = 'https://cdn.discordapp.com/attachments/1478552075469324389/1560015598514339850/IMG_7251.png?ex=6ad12d3e&is=6acfdbbe&hm=0e75236e9ec3ca9abfd30f6d9b76b45d9f884b046b3272dd097e959aece6aebf&';

function toPositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
}

function pick(first, second) {
    const clean = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
    return clean(first) ?? clean(second) ?? '';
}

/**
 * Resolves the effective promotion config for a guild. Never throws —
 * returns safe defaults when the database is unavailable.
 */
async function getPromoConfig(guildId) {
    const file = configService.get('youtube_promotion', {}) || {};
    let guild = null;
    try {
        guild = guildId ? await guildSettingsRepository.getGuildSettings(guildId) : null;
    } catch {
        guild = null;
    }
    const overrides = guild?.youtubePromotion || {};

    const enabled = overrides.enabled ?? file.enabled ?? DEFAULTS.enabled;
    const channelId = pick(overrides.channelId, file.channel_id);
    const allowedRoleId = pick(overrides.allowedRoleId, file.allowed_role_id);

    return {
        enabled: enabled !== false,
        channelId,
        allowedRoleId,
        cooldownSeconds: toPositiveInt(
            file.cooldown_seconds ?? file.cooldownSeconds,
            DEFAULTS.cooldownSeconds
        ),
        duplicateCooldownSeconds: toPositiveInt(
            file.duplicate_cooldown_seconds ?? file.duplicateCooldownSeconds,
            DEFAULTS.duplicateCooldownSeconds
        ),
        // Env var wins; the file value is only a fallback. Never logged.
        youtubeApiKey: (process.env.YOUTUBE_API_KEY || '').trim()
            || String(file.youtube_api_key || '').trim(),
        // Centrally managed banner; per-guild override wins over file config.
        bannerUrl: pick(overrides.bannerUrl, file.banner_url || file.bannerUrl) || DEFAULT_BANNER_URL
    };
}

module.exports = { getPromoConfig, DEFAULTS, DEFAULT_BANNER_URL };
