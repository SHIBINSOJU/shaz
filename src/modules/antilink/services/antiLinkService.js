const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { logAction } = require('../../moderation/services/modLogger');
const { withRetry } = require('../../../utils/retry');
const { isChannelEnforced } = require('../config');

// Per-user warning rate limit: `${guildId}:${userId}` -> timestamp of last warning.
const lastWarningAt = new Map();

function pruneWarningCache(now = Date.now()) {
    if (lastWarningAt.size < 1000) return;
    for (const [key, timestamp] of lastWarningAt) {
        if (now - timestamp > 60_000) lastWarningAt.delete(key);
    }
}

// --- Link detection -------------------------------------------------------
// Layered patterns: explicit schemes/invites first, then bare domains with a
// curated TLD list (avoids naive ".com"-style false positives like
// "version 2.0" or "file.txt"). Code blocks are stripped before testing.

const COMMON_TLDS = [
    'com', 'net', 'org', 'io', 'gg', 'co', 'app', 'dev', 'gov', 'edu',
    'info', 'biz', 'me', 'tv', 'cc', 'xyz', 'site', 'online', 'store',
    'blog', 'forum', 'wiki', 'news', 'shop', 'cloud', 'ai', 'uk', 'us',
    'de', 'fr', 'in', 'au', 'ca', 'nl', 'es', 'it', 'ru', 'br', 'jp'
].join('|');

const LINK_PATTERNS = [
    /https?:\/\/[^\s<>()[\]{}"']+/i,
    /www\.[^\s<>()[\]{}"']*\.[a-z]{2,}(?::\d+)?(?:\/[^\s<>()[\]{}"']*)?/i,
    /discord\.gg\/[^\s<>()[\]{}"']+/i,
    /discord(?:app)?\.com\/invite\/[^\s<>()[\]{}"']+/i,
    new RegExp(`(?:^|[\\s<>()[\\]{}"'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${COMMON_TLDS})(?::\\d{1,5})?(?:\\/[^^\\s<>()[\\]{}"']*)?)`, 'i')
];

function stripCodeBlocks(content) {
    return String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ');
}

function containsLink(content) {
    const text = stripCodeBlocks(content);
    if (!text.trim()) return false;
    return LINK_PATTERNS.some((pattern) => pattern.test(text));
}

// --- Exemptions ------------------------------------------------------------

function isExempt(member, message, effectiveConfig) {
    const exempt = effectiveConfig.exempt || {};

    // Bots and webhooks are identified from the message (member may be null).
    if (message.author?.bot && (exempt.bots ?? true)) return true;
    if (message.webhookId && (exempt.webhooks ?? true)) return true;

    if (!member) return false;

    if ((exempt.administrators ?? true) && member.permissions.has(PermissionFlagsBits.Administrator)) return true;

    if (exempt.moderators ?? false) {
        if (
            member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
            member.permissions.has(PermissionFlagsBits.ManageMessages)
        ) return true;
    }

    const exemptRoles = effectiveConfig.exemptRoles || [];
    if (exemptRoles.length > 0 && member.roles?.cache?.some?.((role) => exemptRoles.includes(role.id))) return true;

    return false;
}

// --- Enforcement -----------------------------------------------------------

function shouldSendWarning(guildId, userId, cooldownMs) {
    const now = Date.now();
    pruneWarningCache(now);
    const key = `${guildId}:${userId}`;
    const last = lastWarningAt.get(key) || 0;
    if (now - last < cooldownMs) return false;
    lastWarningAt.set(key, now);
    return true;
}

async function handleLinkMessage(message, effectiveConfig) {
    const guild = message.guild;

    if (effectiveConfig.deleteMessage ?? true) {
        try {
            await withRetry(() => message.delete(), { attempts: 2 });
        } catch (error) {
            logger.warn(`Anti-Link: could not delete message ${message.id} in #${message.channel?.name}: ${error.message}`);
            return; // Deletion is the core action; skip warn/log if it failed.
        }
    }

    if ((effectiveConfig.warnUser ?? true) && shouldSendWarning(guild.id, message.author.id, effectiveConfig.warningCooldown ?? 10000)) {
        const delay = effectiveConfig.warningDeleteDelay ?? 5000;
        try {
            const warning = await withRetry(() => message.channel.send(
                `🚫 ${message.author}, links are not allowed in this server.\nPlease don't send links here.`
            ), { attempts: 2 });
            if (warning?.delete && delay > 0) {
                setTimeout(() => warning.delete().catch(() => {}), delay);
            }
        } catch (error) {
            logger.warn(`Anti-Link: could not send warning in #${message.channel?.name}: ${error.message}`);
        }
    }

    if (effectiveConfig.logAction ?? true) {
        // Never log message content — it may contain sensitive information.
        await logAction(guild, {
            title: '🛡️ Anti-Link Action',
            accent: 0xED4245,
            fields: [
                { label: 'User', value: `${message.author} (\`${message.author.id}\`)` },
                { label: 'Channel', value: `${message.channel} (\`${message.channel.id}\`)` },
                { label: 'Action', value: 'Message Deleted' },
                { label: 'Reason', value: 'Link detected' }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
}

module.exports = {
    containsLink,
    stripCodeBlocks,
    isExempt,
    isChannelEnforced,
    shouldSendWarning,
    handleLinkMessage,
    // Exposed for tests/diagnostics.
    _lastWarningAt: lastWarningAt
};
