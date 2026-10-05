// Centralized AutoMod action system: DELETE + WARN + TIMEOUT + LOG.
// Every action is permission-checked and failure-tolerant — a failed delete
// or timeout never crashes the pipeline and is reported in logs.

const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { logAction } = require('../../moderation/services/modLogger');
const { withRetry } = require('../../../utils/retry');
const warningRepository = require('../../../database/repositories/warningRepository');
const { checkWarnCooldown } = require('./trackers');

const RULE_LABELS = {
    antiLink: 'Anti-Link',
    antiInvite: 'Anti-Invite',
    antiSpam: 'Anti-Spam',
    antiDuplicate: 'Duplicate Messages',
    antiMentionSpam: 'Mention Spam',
    antiCaps: 'Anti-Caps',
    wordFilter: 'Word Filter',
    antiEveryone: 'Anti-Everyone',
    antiRaid: 'Anti-Raid',
    massSpam: 'Mass Spam'
};

function ruleLabel(rule) {
    return RULE_LABELS[rule] || rule;
}

function botMember(guild) {
    return guild.members.me ?? null;
}

function canDelete(guild) {
    return botMember(guild)?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
}

function canTimeout(guild, member) {
    const me = botMember(guild);
    if (!me) return { ok: false, reason: 'Bot membership is not cached yet.' };
    if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return { ok: false, reason: 'Bot is missing the Moderate Members permission.' };
    }
    if (!member) return { ok: false, reason: 'Target member is not cached.' };
    if (member.id === guild.ownerId) return { ok: false, reason: 'Cannot punish the server owner.' };
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return { ok: false, reason: 'Cannot punish an administrator.' };
    }
    if (member.roles.highest.position >= me.roles.highest.position) {
        return { ok: false, reason: "Target's highest role is not below the bot's highest role." };
    }
    if (!member.manageable) return { ok: false, reason: 'Target is not manageable by the bot.' };
    return { ok: true };
}

async function deleteMessage(message) {
    try {
        await withRetry(() => message.delete(), { attempts: 2 });
        return true;
    } catch (error) {
        logger.warn(`AutoMod: could not delete message ${message.id}: ${error.message}`);
        return false;
    }
}

async function warnMember({ client, guild, channel, member, user, rule, detail, config }) {
    const cooldown = config.rules?.antiSpam?.warnCooldownSeconds ?? 10;
    if (!checkWarnCooldown(guild.id, user.id, rule, cooldown)) return false;

    const reason = `AutoMod ${ruleLabel(rule)}: ${detail}`.slice(0, 500);
    try {
        await warningRepository.addWarning({
            guildId: guild.id,
            userId: user.id,
            moderatorId: client?.user?.id || 'automod',
            reason
        });
    } catch (error) {
        logger.warn(`AutoMod: could not store warning for ${user.id}: ${error.message}`);
    }

    const delay = config.actions?.warnDeleteDelay ?? 5000;
    try {
        const notice = await withRetry(() => channel.send(
            `⚠️ ${user}, your message was removed (${ruleLabel(rule)}). Please follow the server rules.`
        ), { attempts: 2 });
        if (notice?.delete && delay > 0) {
            setTimeout(() => notice.delete().catch(() => {}), delay);
        }
    } catch (error) {
        logger.warn(`AutoMod: could not send warning in #${channel?.name}: ${error.message}`);
    }
    return true;
}

async function timeoutMember({ guild, member, user, rule, detail, durationSeconds }) {
    const check = canTimeout(guild, member);
    if (!check.ok) {
        logger.warn(`AutoMod: timeout skipped for ${user.id}: ${check.reason}`);
        return false;
    }
    try {
        await withRetry(() => member.timeout(
            Math.min(durationSeconds, 2419200) * 1000,
            `AutoMod ${ruleLabel(rule)}: ${detail}`.slice(0, 500)
        ), { attempts: 2 });
        return true;
    } catch (error) {
        logger.warn(`AutoMod: timeout failed for ${user.id}: ${error.message}`);
        return false;
    }
}

async function logViolation({ guild, channel, user, member, rule, detail, actionsTaken }) {
    // Never log message content — it may contain sensitive information.
    await logAction(guild, {
        title: '🛡️ AutoMod Action',
        accent: 0xED4245,
        fields: [
            { label: 'Rule', value: ruleLabel(rule) },
            { label: 'User', value: `${member ?? user} (\`${user.id}\`)` },
            { label: 'Channel', value: `${channel} (\`${channel.id}\`)` },
            { label: 'Action', value: actionsTaken.join(' + ') || 'None' },
            { label: 'Reason', value: detail }
        ],
        footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
    });
}

/**
 * Applies the configured actions for a rule hit. Returns what was done.
 * DELETE and TIMEOUT are permission-gated; WARN is cooldown-gated per
 * user+rule; LOG always fires through the moderation logger.
 */
async function applyAction({ client, guild, channel, member, user, message, rule, detail, config, timeoutSeconds = null }) {
    const actions = config.actions || {};
    const taken = [];
    let deleted = false;

    if (actions.deleteMessage ?? true) {
        if (!canDelete(guild)) {
            logger.warn(`AutoMod: skipping delete in guild ${guild.id} — bot lacks Manage Messages.`);
        } else {
            deleted = await deleteMessage(message);
            if (deleted) taken.push('Message deleted');
        }
    }

    let timedOut = false;
    const timeoutCfg = actions.timeout || {};
    const duration = timeoutSeconds ?? timeoutCfg.duration ?? 300;
    if ((timeoutSeconds !== null || timeoutCfg.enabled) && member) {
        timedOut = await timeoutMember({ guild, member, user, rule, detail, durationSeconds: duration });
        if (timedOut) taken.push(`Timed out (${duration}s)`);
    }

    let warned = false;
    if (actions.warnUser ?? true) {
        warned = await warnMember({ client, guild, channel, member, user, rule, detail, config });
        if (warned) taken.push('Warning issued');
    }

    if (actions.logAction ?? true) {
        await logViolation({ guild, channel, user, member, rule, detail, actionsTaken: taken });
    }

    return { deleted, warned, timedOut, actionsTaken: taken };
}

module.exports = { RULE_LABELS, ruleLabel, canDelete, canTimeout, applyAction };
