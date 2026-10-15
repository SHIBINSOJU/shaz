// Member join / leave / kick-attribution / ban / unban logging.
const { AuditLogEvent } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog, sendLogToCategories, isLogChannelMessage } = require('../services/logDispatcher');
const { fmtTimestamp, userLine, avatarUrlOf } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');

function accountAge(user) {
    return user?.createdTimestamp ? fmtTimestamp(user.createdTimestamp, 'R') : '_unknown_';
}

async function logJoin(member) {
    const user = member.user;
    const isBot = Boolean(user?.bot);
    await sendLog(member.guild, 'member', {
        emoji: isBot ? '🤖' : '📥',
        title: isBot ? 'Bot Joined Server' : 'Member Joined',
        accent: 0x57F287,
        thumbnailUrl: avatarUrlOf(user),
        fields: [
            { label: 'User', value: userLine(user, member) },
            { label: 'Account created', value: `${fmtTimestamp(user?.createdTimestamp)} (${accountAge(user)})` },
            { label: 'Joined', value: fmtTimestamp(member.joinedTimestamp || Date.now()) }
        ],
        footer: `ID: ${user?.id || member.id} • ${new Date().toISOString()}`
    });
}

const guildMemberAdd = {
    name: 'guildMemberAdd',
    async execute(member) {
        try {
            await logJoin(member);
        } catch (error) {
            logger.error(`logs guildMemberAdd failed: ${error.message}`);
        }
    }
};

const guildMemberRemove = {
    name: 'guildMemberRemove',
    async execute(member) {
        try {
            const guild = member.guild;
            const user = member.user || member;

            // Kick attribution: only label as kick when a fresh MemberKick
            // audit entry targets this user. Otherwise it is a plain leave —
            // never falsely label a leave as a kick.
            const kickEntry = await fetchAuditEntry(guild, AuditLogEvent.MemberKick, member.id);
            const kickBy = kickEntry ? executorLine(kickEntry) : null;

            let timeInServer = '_unknown_';
            if (member.joinedTimestamp) {
                const ms = Date.now() - member.joinedTimestamp;
                if (ms >= 0) {
                    const days = Math.floor(ms / 86_400_000);
                    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
                    const mins = Math.floor((ms % 3_600_000) / 60_000);
                    timeInServer = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                }
            }

            const fields = [
                { label: 'User', value: userLine(user, member) },
                { label: 'Account created', value: user?.createdTimestamp ? fmtTimestamp(user.createdTimestamp) : '_unknown_' },
                { label: 'Joined', value: member.joinedTimestamp ? fmtTimestamp(member.joinedTimestamp) : '_unknown_' },
                { label: 'Time in server', value: timeInServer }
            ];

            if (kickBy) {
                fields.push({ label: 'Kicked by', value: kickBy });
                if (kickEntry.reason) fields.push({ label: 'Reason', value: kickEntry.reason });
                await sendLogToCategories(guild, ['member', 'moderation'], {
                    emoji: '👢',
                    title: 'Member Kicked',
                    accent: 0xED4245,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${member.id}`
                });
            } else {
                await sendLog(guild, 'member', {
                    emoji: user?.bot ? '🤖' : '📤',
                    title: user?.bot ? 'Bot Left Server' : 'Member Left',
                    accent: 0xFEE75C,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${member.id}`
                });
            }
        } catch (error) {
            logger.error(`logs guildMemberRemove failed: ${error.message}`);
        }
    }
};

const guildBanAdd = {
    name: 'guildBanAdd',
    async execute(ban) {
        try {
            const guild = ban.guild;
            const user = ban.user;
            const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberBanAdd, user?.id);
            const fields = [
                { label: 'User', value: user ? userLine(user) : `\`${ban.user?.id || 'unknown'}\`` },
                { label: 'Account created', value: user?.createdTimestamp ? fmtTimestamp(user.createdTimestamp) : '_unknown_' }
            ];
            const by = entry ? executorLine(entry) : null;
            if (by) fields.push({ label: 'Banned by', value: by });
            const reason = entry?.reason || ban.reason;
            if (reason) fields.push({ label: 'Reason', value: reason });
            await sendLogToCategories(guild, ['member', 'moderation'], {
                emoji: '🔨',
                title: 'Member Banned',
                accent: 0xED4245,
                thumbnailUrl: avatarUrlOf(user),
                fields,
                footer: `ID: ${user?.id || 'unknown'}`
            });
        } catch (error) {
            logger.error(`logs guildBanAdd failed: ${error.message}`);
        }
    }
};

const guildBanRemove = {
    name: 'guildBanRemove',
    async execute(ban) {
        try {
            const guild = ban.guild;
            const user = ban.user;
            const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberBanRemove, user?.id);
            const fields = [
                { label: 'User', value: user ? userLine(user) : `\`${ban.user?.id || 'unknown'}\`` }
            ];
            const by = entry ? executorLine(entry) : null;
            if (by) fields.push({ label: 'Unbanned by', value: by });
            if (entry?.reason) fields.push({ label: 'Reason', value: entry.reason });
            await sendLogToCategories(guild, ['member', 'moderation'], {
                emoji: '🔓',
                title: 'Member Unbanned',
                accent: 0x57F287,
                thumbnailUrl: avatarUrlOf(user),
                fields,
                footer: `ID: ${user?.id || 'unknown'}`
            });
        } catch (error) {
            logger.error(`logs guildBanRemove failed: ${error.message}`);
        }
    }
};

module.exports = { guildMemberAdd, guildMemberRemove, guildBanAdd, guildBanRemove, _isLogChannelMessage: isLogChannelMessage };
