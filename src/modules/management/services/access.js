// Shared authorization for management commands (/say, /announce, poll
// creation, suggestion review). Reuses the centralized primitives from the
// embed permission service: owner → admin → configured role → deny.
// Management roles come from config `management.allowedRoleIds` plus per-guild
// `GuildSettings.management.allowedRoleIds`. Never throws.

const { PermissionFlagsBits } = require('discord.js');
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isOwner, isAdmin, hasAllowedRole } = require('../../embed/services/permissions');

function coerceIds(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return items
        .filter(id => id !== null && id !== undefined && String(id).trim() !== '')
        .map(id => String(id).trim());
}

async function getManagementRoleIds(guild) {
    const ids = new Set(coerceIds(configService.get('management.allowedRoleIds', []) || []));
    try {
        const settings = await guildSettingsRepository.getGuildSettings(guild.id);
        for (const id of coerceIds(settings?.management?.allowedRoleIds)) ids.add(id);
    } catch {
        // Database unavailable — file config alone still applies.
    }
    return [...ids];
}

// Full management access: owner, administrator, or authorized role.
async function canManage(interaction) {
    if (!interaction.inGuild()) return { ok: false, via: 'dm' };
    if (isOwner(interaction)) return { ok: true, via: 'owner' };
    if (isAdmin(interaction)) return { ok: true, via: 'administrator' };
    const allowed = await getManagementRoleIds(interaction.guild);
    if (hasAllowedRole(interaction.member, allowed)) return { ok: true, via: 'role' };
    return { ok: false, via: 'denied' };
}

// Staff access for suggestion review: management access OR Manage Messages.
async function canReview(interaction) {
    const managed = await canManage(interaction);
    if (managed.ok) return managed;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        return { ok: true, via: 'moderator' };
    }
    return { ok: false, via: 'denied' };
}

const MANAGE_DENY = '❌ You don\'t have permission to use this command.\n\nOnly the server owner, administrators, and authorized roles can use it.';
const REVIEW_DENY = '❌ Only staff members can review suggestions.';

module.exports = { getManagementRoleIds, canManage, canReview, MANAGE_DENY, REVIEW_DENY };
