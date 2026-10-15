// guildMemberUpdate: nickname, timeout, role membership and avatar/display
// changes. Compares old vs new state and only logs real changes.
const { AuditLogEvent } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog, sendLogToCategories } = require('../services/logDispatcher');
const { fmtTimestamp, userLine, avatarUrlOf, truncate } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');

function roleDiff(oldMember, newMember) {
    const oldIds = new Set(oldMember.roles?.cache?.keys?.() || []);
    const newIds = new Set(newMember.roles?.cache?.keys?.() || []);
    const added = [...newIds].filter(id => !oldIds.has(id) && id !== newMember.guild.id);
    const removed = [...oldIds].filter(id => !newIds.has(id) && id !== newMember.guild.id);
    return { added, removed };
}

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember) {
        try {
            const guild = newMember.guild;
            const user = newMember.user;

            // ---- Nickname change ----
            if ((oldMember.nickname || null) !== (newMember.nickname || null)) {
                const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, newMember.id);
                const fields = [
                    { label: 'User', value: userLine(user, newMember) },
                    { label: 'Before', value: oldMember.nickname ? `\`${truncate(oldMember.nickname, 100)}\`` : '_none_' },
                    { label: 'After', value: newMember.nickname ? `\`${truncate(newMember.nickname, 100)}\`` : '_none_' }
                ];
                const by = entry ? executorLine(entry) : null;
                // Only attribute when the audit entry actually changed nick.
                if (by && entry?.changes?.some(c => c.key === 'nick')) fields.push({ label: 'Changed by', value: by });
                await sendLog(guild, 'member', {
                    emoji: '📝',
                    title: 'Nickname Changed',
                    accent: 0x00AFF4,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${user.id}`
                });
            }

            // ---- Timeout change ----
            const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
            const newTimeout = newMember.communicationDisabledUntilTimestamp || null;
            if (oldTimeout !== newTimeout) {
                const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, newMember.id);
                const by = entry ? executorLine(entry) : null;
                let title = '⏳ Timeout Updated';
                let emoji = '⏳';
                if (!oldTimeout && newTimeout) { title = 'Timeout Started'; emoji = '⏳'; }
                else if (oldTimeout && !newTimeout) { title = 'Timeout Removed'; emoji = '✅'; }
                const fields = [
                    { label: 'User', value: userLine(user, newMember) },
                    { label: 'Until', value: newTimeout ? fmtTimestamp(newTimeout) : '_removed_' }
                ];
                if (by) fields.push({ label: 'Moderator', value: by });
                if (entry?.reason) fields.push({ label: 'Reason', value: entry.reason });
                await sendLogToCategories(guild, ['member', 'moderation'], {
                    emoji,
                    title,
                    accent: 0xED4245,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${user.id}`
                });
            }

            // ---- Role membership ----
            const { added, removed } = roleDiff(oldMember, newMember);
            if (added.length > 0 || removed.length > 0) {
                const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
                const by = entry ? executorLine(entry) : null;
                const nameOf = (id) => {
                    const role = guild.roles?.cache?.get(id);
                    return role ? `${role} (\`${role.name}\`)` : `\`deleted role\` (\`${id}\`)`;
                };
                const fields = [{ label: 'User', value: userLine(user, newMember) }];
                if (added.length > 0) fields.push({ label: added.length > 1 ? 'Roles added' : 'Role added', value: added.map(nameOf).join('\n') });
                if (removed.length > 0) fields.push({ label: removed.length > 1 ? 'Roles removed' : 'Role removed', value: removed.map(nameOf).join('\n') });
                if (by) fields.push({ label: 'Changed by', value: by });
                await sendLogToCategories(guild, ['member', 'role'], {
                    emoji: added.length > 0 ? '➕' : '➖',
                    title: added.length > 0 && removed.length === 0 ? 'Role Added' : removed.length > 0 && added.length === 0 ? 'Role Removed' : 'Roles Updated',
                    accent: 0xEB459E,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${user.id}`
                });
            }

            // ---- Avatar / display-name changes (reliably detectable diffs) ----
            const oldAvatar = oldMember.user?.displayAvatarURL?.() || null;
            const newAvatar = newMember.user?.displayAvatarURL?.() || null;
            const avatarChanged = oldAvatar && newAvatar && oldAvatar !== newAvatar;
            const usernameChanged = oldMember.user?.tag !== newMember.user?.tag;
            if (avatarChanged || usernameChanged) {
                const fields = [{ label: 'User', value: userLine(user, newMember) }];
                if (usernameChanged) {
                    fields.push({ label: 'Before', value: `\`${oldMember.user.tag}\`` });
                    fields.push({ label: 'After', value: `\`${newMember.user.tag}\`` });
                } else {
                    fields.push({ label: 'Change', value: 'Avatar updated' });
                }
                await sendLog(guild, 'member', {
                    emoji: '🖼️',
                    title: usernameChanged ? 'Username Changed' : 'Avatar Changed',
                    accent: 0x00AFF4,
                    thumbnailUrl: avatarUrlOf(user),
                    fields,
                    footer: `ID: ${user.id}`
                });
            }
        } catch (error) {
            logger.error(`logs guildMemberUpdate failed: ${error.message}`);
        }
    }
};
