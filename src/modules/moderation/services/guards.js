const MAX_REASON_LENGTH = 500;

function sanitizeReason(reason) {
    if (!reason) return 'No reason provided.';
    const trimmed = String(reason).trim();
    if (!trimmed) return 'No reason provided.';
    return trimmed.length > MAX_REASON_LENGTH
        ? `${trimmed.slice(0, MAX_REASON_LENGTH - 1)}…`
        : trimmed;
}

/**
 * Shared moderation validation. Returns { ok: true, member } or { ok: false, error }.
 * Checks: guild-only, executor permission, self-target, bot-target, owner,
 * role hierarchy (executor + bot) and optional member presence.
 */
async function validateTarget({ interaction, targetUser, action, permission, requireMember = true }) {
    if (!interaction.inGuild()) {
        return { ok: false, error: '❌ This command can only be used inside a server.' };
    }

    const guild = interaction.guild;

    if (!interaction.memberPermissions?.has(permission)) {
        return { ok: false, error: `❌ You are missing the required permission to ${action} members.` };
    }

    if (!guild.members.me.permissions.has(permission)) {
        return { ok: false, error: `❌ I am missing the required permission to ${action} members.` };
    }

    if (targetUser.id === interaction.user.id) {
        return { ok: false, error: `❌ You cannot ${action} yourself.` };
    }

    if (targetUser.id === interaction.client.user.id) {
        return { ok: false, error: `❌ I cannot ${action} myself.` };
    }

    if (targetUser.id === guild.ownerId) {
        return { ok: false, error: `❌ You cannot ${action} the server owner.` };
    }

    const member = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        if (requireMember) {
            return { ok: false, error: '❌ That user is not a member of this server.' };
        }
        return { ok: true, member: null };
    }

    const executor = interaction.member;
    const isOwner = interaction.user.id === guild.ownerId;

    if (!isOwner && member.roles.highest.position >= executor.roles.highest.position) {
        return { ok: false, error: `❌ You cannot ${action} **${member.displayName}** — their highest role is equal to or above yours.` };
    }

    if (member.roles.highest.position >= guild.members.me.roles.highest.position) {
        return { ok: false, error: `❌ I cannot ${action} **${member.displayName}** — their highest role is equal to or above mine.` };
    }

    return { ok: true, member };
}

module.exports = { validateTarget, sanitizeReason, MAX_REASON_LENGTH };
