// Role logging: created / deleted / renamed / color / permissions /
// position / display settings, with audit attribution when available.
const { AuditLogEvent } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog } = require('../services/logDispatcher');
const { truncate } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');

function roleRef(role) {
    return `${role} (\`${role?.name || 'unknown'}\`)`;
}

function permDiff(oldPerms, newPerms) {
    const added = newPerms.missing(oldPerms.bitfield);
    const removed = oldPerms.missing(newPerms.bitfield);
    return { added, removed };
}

async function attribute(guild, type, targetId) {
    const entry = await fetchAuditEntry(guild, type, targetId);
    return entry ? { by: executorLine(entry), reason: entry.reason || null } : { by: null, reason: null };
}

const roleCreate = {
    name: 'roleCreate',
    async execute(role) {
        try {
            if (!role?.guild) return;
            const { by } = await attribute(role.guild, AuditLogEvent.RoleCreate, role.id);
            const fields = [{ label: 'Role', value: roleRef(role) }];
            if (by) fields.push({ label: 'Created by', value: by });
            await sendLog(role.guild, 'role', {
                emoji: '🎭',
                title: 'Role Created',
                accent: 0x57F287,
                thumbnailUrl: null,
                fields,
                footer: `Role ID: ${role.id}`
            });
        } catch (error) {
            logger.error(`logs roleCreate failed: ${error.message}`);
        }
    }
};

const roleDelete = {
    name: 'roleDelete',
    async execute(role) {
        try {
            if (!role?.guild) return;
            const { by } = await attribute(role.guild, AuditLogEvent.RoleDelete, role.id);
            const fields = [
                { label: 'Role', value: `\`${truncate(role.name, 100)}\` (\`${role.id}\`)` },
                { label: 'Color', value: role.hexColor || '_default_' },
                { label: 'Members', value: String(role.members?.size ?? '?') }
            ];
            if (by) fields.push({ label: 'Deleted by', value: by });
            await sendLog(role.guild, 'role', {
                emoji: '🗑️',
                title: 'Role Deleted',
                accent: 0xED4245,
                thumbnailUrl: null,
                fields,
                footer: `Role ID: ${role.id}`
            });
        } catch (error) {
            logger.error(`logs roleDelete failed: ${error.message}`);
        }
    }
};

const roleUpdate = {
    name: 'roleUpdate',
    async execute(oldRole, newRole) {
        try {
            if (!newRole?.guild) return;
            const diffs = [];

            if (oldRole.name !== newRole.name) {
                diffs.push({ label: 'Name', value: `\`${truncate(oldRole.name, 100)}\` → \`${truncate(newRole.name, 100)}\`` });
            }
            if (oldRole.hexColor !== newRole.hexColor) {
                diffs.push({ label: 'Color', value: `${oldRole.hexColor} → ${newRole.hexColor}` });
            }
            if (oldRole.permissions?.bitfield !== newRole.permissions?.bitfield) {
                const { added, removed } = permDiff(oldRole.permissions, newRole.permissions);
                const parts = [];
                if (added.length > 0) parts.push(`+ ${added.slice(0, 10).join(', ')}`);
                if (removed.length > 0) parts.push(`- ${removed.slice(0, 10).join(', ')}`);
                diffs.push({ label: 'Permissions', value: truncate(parts.join('\n') || 'Changed', 600) });
            }
            if (oldRole.position !== newRole.position) {
                diffs.push({ label: 'Position', value: `${oldRole.position} → ${newRole.position}` });
            }
            if ((oldRole.hoist || false) !== (newRole.hoist || false)) {
                diffs.push({ label: 'Displayed separately', value: newRole.hoist ? 'Enabled' : 'Disabled' });
            }
            if ((oldRole.mentionable || false) !== (newRole.mentionable || false)) {
                diffs.push({ label: 'Mentionable', value: newRole.mentionable ? 'Enabled' : 'Disabled' });
            }
            if (String(oldRole.icon || '') !== String(newRole.icon || '')) {
                diffs.push({ label: 'Icon', value: newRole.icon ? 'Updated' : 'Removed' });
            }

            if (diffs.length === 0) return;

            const entry = await fetchAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
            const fields = [{ label: 'Role', value: roleRef(newRole) }, ...diffs];
            if (entry && executorLine(entry)) fields.push({ label: 'Updated by', value: executorLine(entry) });

            await sendLog(newRole.guild, 'role', {
                emoji: '✏️',
                title: 'Role Updated',
                accent: 0xFEE75C,
                thumbnailUrl: null,
                fields,
                footer: `Role ID: ${newRole.id}`
            });
        } catch (error) {
            logger.error(`logs roleUpdate failed: ${error.message}`);
        }
    }
};

module.exports = { roleCreate, roleDelete, roleUpdate };
