// Authorization for the /embed builder. Hierarchy (first match wins):
//   SERVER OWNER → ADMINISTRATOR → configured embed role → DENIED.
// Effective allowed roles = config.yml `allowedRoleIds` ∪ per-guild
// `GuildSettings.embed.allowedRoleIds` (managed via /embedconfig).
// IDs stay strings throughout. Never throws.

const { PermissionFlagsBits } = require('discord.js');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { coerceIdList } = require('../config');

async function getEffectiveAllowedRoleIds(guild, fileRoleIds) {
    const ids = new Set(coerceIdList(fileRoleIds));
    try {
        const db = await guildSettingsRepository.getGuildSettings(guild.id);
        for (const id of coerceIdList(db?.embed?.allowedRoleIds)) ids.add(id);
    } catch {
        // Database unavailable — file config alone still applies.
    }
    return [...ids];
}

function isOwner(interaction) {
    return interaction.guild?.ownerId === interaction.user.id;
}

function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function hasAllowedRole(member, allowedRoleIds) {
    if (!allowedRoleIds || allowedRoleIds.length === 0) return false;
    const cache = member?.roles?.cache;
    if (!cache) return false;
    return allowedRoleIds.some((roleId) => cache.has(roleId));
}

// USE permission: owner, admin (when required by config), or allowed role.
async function canUseEmbed(interaction, builderConfig) {
    if (isOwner(interaction)) return { ok: true, via: 'owner' };
    if (isAdmin(interaction)) {
        // Administrators always pass; the config flag only controls whether
        // admin alone is *required* vs merely sufficient. Owner bypasses all.
        return { ok: true, via: 'administrator' };
    }
    const allowed = await getEffectiveAllowedRoleIds(interaction.guild, builderConfig.allowedRoleIds);
    if (hasAllowedRole(interaction.member, allowed)) return { ok: true, via: 'role' };
    return { ok: false, via: 'denied' };
}

// CONFIGURE permission: owner or admin only. Allowed-role users may USE
// the builder but must never change who else can use it.
function canConfigureEmbed(interaction) {
    return isOwner(interaction) || isAdmin(interaction);
}

const DENY_MESSAGE = '❌ You don\'t have permission to use `/embed`.\n\nOnly server owners, administrators, and authorized embed roles can use this command.';

module.exports = {
    getEffectiveAllowedRoleIds,
    isOwner,
    isAdmin,
    hasAllowedRole,
    canUseEmbed,
    canConfigureEmbed,
    DENY_MESSAGE
};
