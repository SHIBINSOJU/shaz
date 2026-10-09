// Ticket channel naming + creation with least-privilege overwrites.

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const logger = require('../../../core/logger');

function sanitizeSegment(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-_]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 40) || 'user';
}

function buildTicketName(format, { username, category, number }) {
    const base = String(format || 'ticket-{username}')
        .replace(/\{username\}/gi, sanitizeSegment(username))
        .replace(/\{category\}/gi, sanitizeSegment(category))
        .replace(/\{number\}/gi, String(number));
    // Discord channel names: lowercase alphanumeric, hyphens, underscores.
    return base
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 90) || `ticket-${number}`;
}

function uniqueChannelName(guild, baseName) {
    const taken = new Set([...guild.channels.cache.values()].map((c) => c.name));
    if (!taken.has(baseName)) return baseName;
    for (let i = 2; i < 100; i++) {
        const candidate = `${baseName}-${i}`.slice(0, 100);
        if (!taken.has(candidate)) return candidate;
    }
    return `${baseName}-${Date.now().toString(36)}`.slice(0, 100);
}

// Splits configured staff roles into existing guild roles + missing IDs
// (missing roles warn instead of failing creation). Falls back to a direct
// fetch so a cold role cache can never silently drop the mention.
async function resolveStaffRoles(guild, staffRoleIds) {
    const existing = [];
    const missing = [];
    for (const roleId of staffRoleIds || []) {
        const id = String(roleId);
        const role = guild.roles.cache.get(id)
            || await guild.roles.fetch(id).catch(() => null);
        if (role) existing.push(role);
        else missing.push(id);
    }
    return { existing, missing };
}

// Resolves the ticket CREATOR's channel-safe name segment from the stored
// ticket.userId (never from whoever clicked a button). Falls back to 'user'
// only when the account is truly unresolvable (left/deleted).
async function resolveCreatorSegment(guild, userId) {
    const id = String(userId);
    try {
        const member = guild.members.cache.get(id)
            || await guild.members.fetch(id).catch(() => null);
        const memberName = member?.user?.username || member?.displayName || null;
        if (memberName) return sanitizeSegment(memberName);
        const user = await guild.client.users.fetch(id).catch(() => null);
        if (user?.username) return sanitizeSegment(user.username);
    } catch {
        // Fall through to the safe fallback below.
    }
    return 'user';
}

// Single canonical ticket channel name builder. OPEN -> ticket-<number>,
// CLOSED -> closed-<number>. Derived from the atomic per-guild ticket
// counter (ticket.number), so names stay sequential, unique, and stable
// across claim/close/reopen/delete by any staff member — no username
// lookups, no renames when the creator leaves, no ID reuse.
async function buildTicketChannelName(guild, ticket, state) {
    void guild;
    const number = Number(ticket?.number);
    if (!Number.isFinite(number)) return `ticket-${Date.now().toString(36)}`;
    const base = state === 'closed' ? `closed-${number}` : `ticket-${number}`;
    return base.slice(0, 100) || `ticket-${number}`;
}

async function createTicketChannel({ guild, client, name, categoryChannelId, userId, staffRoles }) {
    const overwrites = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
        },
        {
            id: userId,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        },
        ...staffRoles.map((role) => ({
            id: role.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages
            ]
        })),
        // The bot needs channel management rights; never Administrator.
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages
            ]
        }
    ];

    const options = {
        name,
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites,
        reason: `Ticket opened by ${userId}`
    };

    if (categoryChannelId) {
        const parent = await guild.channels.fetch(categoryChannelId).catch(() => null);
        if (parent && parent.type === ChannelType.GuildCategory) {
            options.parent = parent.id;
        } else {
            logger.warn(`Tickets: configured category ${categoryChannelId} is missing or not a category; creating ticket at top level.`);
        }
    }

    return guild.channels.create(options);
}

module.exports = {
    sanitizeSegment,
    buildTicketName,
    uniqueChannelName,
    resolveStaffRoles,
    resolveCreatorSegment,
    buildTicketChannelName,
    createTicketChannel
};
