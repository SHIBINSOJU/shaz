// Autorole assignment engine. Validates every role before touching a member,
// assigns all assignable roles (one failure never stops the rest), and logs
// via the existing moderation logging system. Never throws — all failures
// are collected per role and reported to logs.

const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { logAction } = require('../../moderation/services/modLogger');
const { withRetry } = require('../../../utils/retry');

function timestamp() {
    return `<t:${Math.floor(Date.now() / 1000)}:F>`;
}

/**
 * Checks whether the bot may assign `role` right now.
 * Returns { ok: true } or { ok: false, reason }.
 */
function checkRoleAssignable(guild, role) {
    if (!role) {
        return { ok: false, reason: 'Role no longer exists.' };
    }
    if (role.id === guild.id) {
        return { ok: false, reason: 'The @everyone role cannot be assigned.' };
    }
    if (role.managed) {
        return { ok: false, reason: 'The role is managed by an integration and cannot be assigned manually.' };
    }
    const me = guild.members.me;
    if (!me) {
        return { ok: false, reason: 'Bot membership is not cached yet.' };
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return { ok: false, reason: 'Bot is missing the Manage Roles permission.' };
    }
    if (role.position >= me.roles.highest.position) {
        return { ok: false, reason: "Bot's highest role is not above this role." };
    }
    return { ok: true };
}

async function fetchRole(guild, roleId) {
    return guild.roles.fetch(roleId).catch(() => null);
}

async function logAssignment(guild, member, assignedRoles, failures, logsEnabled) {
    if (!logsEnabled) return;
    if (assignedRoles.length > 0) {
        await logAction(guild, {
            title: '👤 Autorole Assigned',
            accent: 0x57F287,
            fields: [
                { label: 'User', value: `${member} (\`${member.id}\`)` },
                { label: 'Role', value: assignedRoles.map((r) => `${r}`).join(', ') },
                { label: 'Action', value: 'Automatic role assignment' }
            ],
            footer: timestamp()
        });
    }
    for (const failure of failures) {
        await logAction(guild, {
            title: '⚠️ Autorole Failed',
            accent: 0xED4245,
            fields: [
                { label: 'User', value: `${member} (\`${member.id}\`)` },
                { label: 'Role', value: failure.role ? `${failure.role} (\`${failure.role.id}\`)` : `\`${failure.roleId}\`` },
                { label: 'Reason', value: failure.reason }
            ],
            footer: timestamp()
        });
    }
}

/**
 * Assigns all configured autoroles to `member`.
 * Returns { assigned: Role[], failures: [{ roleId, role, reason }] }.
 */
async function assignAutoroles(member, config) {
    const guild = member.guild;
    const roleIds = [...new Set(config.roles || [])];
    const assigned = [];
    const failures = [];

    for (const roleId of roleIds) {
        let role;
        try {
            role = await fetchRole(guild, roleId);
        } catch (error) {
            failures.push({ roleId, role: null, reason: `Could not fetch the role: ${error.message}` });
            continue;
        }
        const check = checkRoleAssignable(guild, role);
        if (!check.ok) {
            failures.push({ roleId, role: role || null, reason: check.reason });
            logger.warn(`Autorole: skipping role ${roleId} for ${member.id}: ${check.reason}`);
            continue;
        }
        if (member.roles.cache.has(role.id)) {
            continue;
        }
        try {
            await withRetry(() => member.roles.add(role, 'Autorole: automatic assignment on join'), { attempts: 2 });
            assigned.push(role);
        } catch (error) {
            failures.push({ roleId, role, reason: error.message });
            logger.warn(`Autorole: failed to assign ${role.name} to ${member.id}: ${error.message}`);
        }
    }

    await logAssignment(guild, member, assigned, failures, config.logs?.enabled ?? true);
    return { assigned, failures };
}

module.exports = { checkRoleAssignable, assignAutoroles };
