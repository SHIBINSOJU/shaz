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
// (missing roles warn instead of failing creation).
function resolveStaffRoles(guild, staffRoleIds) {
    const existing = [];
    const missing = [];
    for (const roleId of staffRoleIds || []) {
        const role = guild.roles.cache.get(roleId) || null;
        if (role) existing.push(role);
        else missing.push(roleId);
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

// Single canonical ticket channel name builder. OPEN -> ticket-<creator>,
// CLOSED -> closed-<creator>. Always derived from ticket.userId so the name
// survives claim/close/reopen/delete by other staff members.
async function buildTicketChannelName(guild, ticket, state) {
    const segment = await resolveCreatorSegment(guild, ticket.userId);
    const base = state === 'closed' ? `closed-${segment}` : `ticket-${segment}`;
    return base.slice(0, 100) || `ticket-${ticket.number}`;
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
