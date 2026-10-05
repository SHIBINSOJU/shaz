// AutoMod engine: the ONE message event pipeline.
//
// messageCreate -> exemptions -> rule evaluation (first hit wins) -> actions.
// Anti-Link reuses the existing antilink module's detection, config, and
// enforcement verbatim — no duplicate anti-link system.
//
// The legacy antilink listener defers to this engine via automodHandlesLinks()
// so a link is never processed twice. If this module is disabled, the legacy
// listener keeps working standalone.

const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { logAction } = require('../../moderation/services/modLogger');
const { resolveAutomodConfig, invalidateAutomodConfig } = require('../config');
const { resolveAntiLinkConfig } = require('../../antilink/config');
const { containsLink, handleLinkMessage } = require('../../antilink/services/antiLinkService');
const {
    recordMessage,
    recordDuplicate,
    recordJoin: trackJoin,
    checkRaidAlertCooldown
} = require('./trackers');
const {
    normalizeContent,
    checkAntiInvite,
    checkAntiSpam,
    checkMassSpam,
    checkAntiDuplicate,
    checkAntiMentionSpam,
    checkAntiEveryone,
    checkAntiCaps,
    checkWordFilter
} = require('./rules');
const { applyAction, ruleLabel } = require('./actions');

let active = false;
function setActive(value) { active = value; }
function isActive() { return active; }

// Anti-link config cache (same TTL discipline as the automod config cache;
// /automod mutations invalidate both).
const linkConfigCache = new Map();
const LINK_CACHE_TTL_MS = 30 * 1000;

async function getLinkConfig(guild) {
    const cached = linkConfigCache.get(guild.id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;
    const config = await resolveAntiLinkConfig(guild);
    linkConfigCache.set(guild.id, { config, expiresAt: Date.now() + LINK_CACHE_TTL_MS });
    return config;
}

function invalidateLinkConfig(guildId) {
    linkConfigCache.delete(guildId);
}

// True when this engine will handle links for the guild — the legacy
// antilink listener uses this to avoid double-processing.
async function automodHandlesLinks(guild) {
    if (!active) return false;
    try {
        const [autoCfg, linkCfg] = await Promise.all([
            resolveAutomodConfig(guild),
            getLinkConfig(guild)
        ]);
        return autoCfg.enabled
            && (autoCfg.rules?.antiLink?.enabled ?? true)
            && (linkCfg.enabled ?? true);
    } catch {
        return false;
    }
}

function isExempt(member, message, config) {
    const exempt = config.exemptions || {};

    // Server owner is never punished.
    if (member.id === message.guild.ownerId) return true;

    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    if (isAdmin && !(exempt.punishAdmins ?? false)) return true;

    if ((exempt.userIds || []).includes(member.id)) return true;
    if ((exempt.channelIds || []).includes(message.channelId)) return true;
    const roleIds = exempt.roleIds || [];
    if (roleIds.length > 0 && member.roles?.cache?.some?.((role) => roleIds.includes(role.id))) return true;

    return false;
}

async function resolveMember(message) {
    if (message.member) return message.member;
    return message.guild.members.fetch(message.author.id).catch(() => null);
}

async function handleMessage(message, client) {
    try {
        if (!message.inGuild()) return { handled: false };
        if (!message.content) return { handled: false };
        if (message.author?.bot) return { handled: false };
        if (message.webhookId) return { handled: false };

        const guild = message.guild;
        const config = await resolveAutomodConfig(guild);
        if (!config.enabled) return { handled: false };

        const member = await resolveMember(message);
        if (!member) return { handled: false };
        if (isExempt(member, message, config)) return { handled: false };

        const rules = config.rules || {};
        const now = Date.now();

        // Track first (spam/duplicate need history across all messages).
        const spamWindow = Math.max(
            rules.antiSpam?.intervalSeconds ?? 5,
            rules.massSpam?.intervalSeconds ?? 10
        );
        const spamCount = recordMessage(guild.id, member.id, spamWindow, now);

        const normalized = normalizeContent(message.content);
        let dupCount = 0;
        if (normalized.length >= 4) {
            dupCount = recordDuplicate(guild.id, member.id, normalized, rules.antiDuplicate?.intervalSeconds ?? 10, now);
        }

        const channel = message.channel;
        const user = message.author;
        const ctx = { client, guild, channel, member, user, message, config };

        // Priority order — first hit wins so one message yields one action.
        if (rules.antiEveryone?.enabled ?? true) {
            const hit = checkAntiEveryone(message);
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiEveryone', detail: hit.detail });
                return { handled: true, rule: 'antiEveryone' };
            }
        }

        if (rules.antiInvite?.enabled ?? true) {
            const hit = checkAntiInvite(message.content);
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiInvite', detail: hit.detail });
                return { handled: true, rule: 'antiInvite' };
            }
        }

        if (rules.antiLink?.enabled ?? true) {
            const linkCfg = await getLinkConfig(guild);
            if ((linkCfg.enabled ?? true) && containsLink(message.content)) {
                // Legacy enforcement: identical delete + warn + log behavior,
                // honoring the existing /antilink configuration and cooldowns.
                await handleLinkMessage(message, linkCfg);
                return { handled: true, rule: 'antiLink' };
            }
        }

        if (rules.wordFilter?.enabled ?? true) {
            const hit = checkWordFilter(message.content, rules.wordFilter?.words || []);
            if (hit) {
                await applyAction({ ...ctx, rule: 'wordFilter', detail: hit.detail });
                return { handled: true, rule: 'wordFilter' };
            }
        }

        if (rules.antiMentionSpam?.enabled ?? true) {
            const hit = checkAntiMentionSpam(message, rules.antiMentionSpam || {});
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiMentionSpam', detail: hit.detail });
                return { handled: true, rule: 'antiMentionSpam' };
            }
        }

        // Mass spam is checked before regular spam: the higher threshold
        // wins so extreme floods escalate to timeout instead of warn-only.
        if (rules.massSpam?.enabled ?? true) {
            const hit = checkMassSpam(spamCount, rules.massSpam || {});
            if (hit) {
                const timeoutOn = config.actions?.timeout?.enabled ?? false;
                const duration = timeoutOn ? (config.actions?.timeout?.duration ?? 300) : null;
                await applyAction({ ...ctx, rule: 'massSpam', detail: hit.detail, timeoutSeconds: duration });
                return { handled: true, rule: 'massSpam' };
            }
        }

        if (rules.antiSpam?.enabled ?? true) {
            const hit = checkAntiSpam(spamCount, rules.antiSpam || {});
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiSpam', detail: hit.detail });
                return { handled: true, rule: 'antiSpam' };
            }
        }

        if (rules.antiDuplicate?.enabled ?? true) {
            const hit = checkAntiDuplicate(dupCount, rules.antiDuplicate || {});
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiDuplicate', detail: hit.detail });
                return { handled: true, rule: 'antiDuplicate' };
            }
        }

        if (rules.antiCaps?.enabled ?? true) {
            const hit = checkAntiCaps(message.content, rules.antiCaps || {});
            if (hit) {
                await applyAction({ ...ctx, rule: 'antiCaps', detail: hit.detail });
                return { handled: true, rule: 'antiCaps' };
            }
        }

        return { handled: false };
    } catch (error) {
        logger.error(`AutoMod engine failed: ${error.message}`);
        return { handled: false };
    }
}

// --- Raid tracking (guildMemberAdd path) ------------------------------------

// Recent joins per guild for optional lockdown timeouts.
const recentJoins = new Map(); // guildId -> [{ id, at }]

async function recordJoin(member, client) {
    try {
        const guild = member.guild;
        const config = await resolveAutomodConfig(guild);
        if (!config.enabled) return;
        const rule = config.rules?.antiRaid || {};
        if (!(rule.enabled ?? true)) return;

        const interval = rule.intervalSeconds ?? 10;
        const threshold = rule.joins ?? 5;
        const count = trackJoin(guild.id, interval);

        let arr = recentJoins.get(guild.id);
        if (!arr) {
            arr = [];
            recentJoins.set(guild.id, arr);
        }
        arr.push({ id: member.id, at: Date.now() });
        const cutoff = Date.now() - interval * 1000;
        while (arr.length > 0 && arr[0].at < cutoff) arr.shift();

        if (count < threshold) return;
        const alertCooldown = rule.alertCooldownSeconds ?? 300;
        if (!checkRaidAlertCooldown(guild.id, alertCooldown)) return;

        let lockdownNote = 'No lockdown (alert only).';
        if (rule.lockdown) {
            const minutes = rule.raidTimeoutMinutes ?? 10;
            let quarantined = 0;
            for (const entry of [...arr]) {
                try {
                    const target = await guild.members.fetch(entry.id).catch(() => null);
                    if (!target || target.user.bot) continue;
                    if (target.id === guild.ownerId) continue;
                    if (target.permissions.has(PermissionFlagsBits.Administrator)) continue;
                    const me = guild.members.me;
                    if (!me?.permissions.has(PermissionFlagsBits.ModerateMembers)) break;
                    if (!target.manageable || target.roles.highest.position >= me.roles.highest.position) continue;
                    await target.timeout(minutes * 60 * 1000, `AutoMod Anti-Raid lockdown (${count} joins in ${interval}s)`).catch(() => null);
                    quarantined++;
                } catch {
                    // Per-member failures must not stop the sweep.
                }
            }
            lockdownNote = `Lockdown enabled — ${quarantined} recent joiner(s) timed out for ${minutes}m.`;
        }

        logger.warn(`AutoMod: possible raid in guild ${guild.id} — ${count} joins in ${interval}s. ${lockdownNote}`);
        await logAction(guild, {
            title: '🚨 Possible Raid Detected',
            accent: 0xED4245,
            fields: [
                { label: 'Rule', value: 'Anti-Raid' },
                { label: 'Guild', value: `${guild.name} (\`${guild.id}\`)` },
                { label: 'Joins', value: `${count} in ${interval} seconds` },
                { label: 'Latest join', value: `${member.user?.tag ?? member.id} (\`${member.id}\`)` },
                { label: 'Action', value: lockdownNote }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    } catch (error) {
        logger.error(`AutoMod raid tracking failed: ${error.message}`);
    }
}

module.exports = {
    setActive,
    isActive,
    automodHandlesLinks,
    invalidateLinkConfig,
    handleMessage,
    recordJoin,
    isExempt,
    ruleLabel
};
