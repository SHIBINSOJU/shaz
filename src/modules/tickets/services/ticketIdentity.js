// Shared plain-text identity helpers for ticket logs + transcripts.
//
// NO-MENTION POLICY: every log/transcript string in this system must be
// plain text. Never emit `<@id>`, `<@!id>`, `<@&id>` or `@everyone` /
// `@here`. All sends additionally use explicit allowedMentions scopes
// (creatorMentionScope for the welcome message, NO_MENTIONS elsewhere)
// so even accidental mention-shaped text can never ping.

// Blocks every mention type at the API level. Spread into every
// channel.send / interaction payload produced by the ticket system,
// except the initial welcome message (see creatorMentionScope below).
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

// Zero-width-space breaks `@everyone` / `@here` so they can never ping
// even if Discord ever parsed them from content.
function neutralizeEveryone(text) {
    return String(text ?? '')
        .replace(/@everyone/gi, '@\u200beveryone')
        .replace(/@here/gi, '@\u200bhere');
}

// STRICT MENTION POLICY — exactly two intentional mention types exist:
//   A) Ticket creator mention (<@creatorId>) — ONLY in the initial welcome
//      message sent when the ticket channel is created.
//   B) Configured support-role mention (<@&roleId>) — ONLY in that same
//      welcome message, ONLY for role IDs taken from configuration
//      (per-category staffRoleIds [+ optional global supportRoleId]),
//      and ONLY when at least one is configured.
// Everything else (logs, transcripts, claim/close/reopen/delete notices,
// confirm prompts) is plain text: username + User ID, never <@id>.
// There is NO hardcoded role/user mention anywhere (@god, @everyone,
// @here are never emitted).

// allowedMentions scope for the welcome message: explicitly allow ONLY the
// creator user + the configured support roles. Never parse everyone/here.
function creatorMentionScope(creatorId, roleIds) {
    const roles = (roleIds || []).map((id) => String(id)).filter(Boolean);
    return Object.freeze({
        parse: [],
        users: [String(creatorId)],
        roles,
        repliedUser: false
    });
}

// Sanitize user-controlled text for IN-CHANNEL display (welcome message,
// reason lines). Breaks @everyone/@here so they can never ping, preserves
// line breaks, caps length. Legitimate ticket mentions (<@creator>,
// <@&role>) are added by the bot itself — never from this input — and the
// strict allowedMentions scope above means stray <@id> text from users
// cannot ping anyone anyway.
function sanitizeMessageInput(value, max = 1000) {
    let text = neutralizeEveryone(String(value ?? '').trim());
    if (text.length > max) text = `${text.slice(0, max - 1)}…`;
    return text || '—';
}

// Plain-text safe: strips mention syntax, neutralizes everyone/here,
// trims, caps length. Used for ALL user-controlled text in logs/HTML.
function safePlainText(value, max = 1000) {
    let text = neutralizeEveryone(String(value ?? '').trim());
    text = text
        .replace(/<@!?(\d+)>/g, '@$1')
        .replace(/<#(\d+)>/g, '#$1')
        .replace(/<@&(\d+)>/g, '@role:$1');
    if (text.length > max) text = `${text.slice(0, max - 1)}…`;
    return text || '—';
}

// Discord display cap for usernames in logs.
function displayNameOf(user, member) {
    const name = member?.displayName || user?.displayName || user?.username || user?.globalName || null;
    return safePlainText(name || 'Unknown User', 100);
}

// Resolve a guild user's plain-text identity without ever mentioning.
// Returns { id, username, displayName }. Falls back to stored snapshots,
// then to raw IDs — never throws, never pings.
async function resolveUserIdentity(guild, userId, fallback = {}) {
    const id = String(userId || fallback.id || 'unknown');
    try {
        const member = guild?.members?.cache?.get(id)
            || await guild?.members?.fetch(id).catch(() => null);
        if (member?.user) {
            return {
                id,
                username: safePlainText(member.user.username || fallback.username || 'Unknown User', 100),
                displayName: safePlainText(member.displayName || member.user.username || fallback.username || 'Unknown User', 100)
            };
        }
        const user = guild?.client?.users?.cache?.get(id)
            || await guild?.client?.users?.fetch(id).catch(() => null);
        if (user) {
            return {
                id,
                username: safePlainText(user.username || fallback.username || 'Unknown User', 100),
                displayName: safePlainText(user.displayName || user.username || fallback.username || 'Unknown User', 100)
            };
        }
    } catch { /* fall through to snapshots */ }
    return {
        id,
        username: safePlainText(fallback.username || fallback.displayName || 'Unknown User', 100),
        displayName: safePlainText(fallback.displayName || fallback.username || 'Unknown User', 100)
    };
}

// Resolve the ticket channel's display name. Never returns "#unknown":
// live channel -> stored channelName -> ticket-<number> fallback.
async function resolveTicketChannelName(guild, ticket) {
    const stored = ticket?.channelName ? String(ticket.channelName) : null;
    try {
        const channel = guild?.channels?.cache?.get(String(ticket?.channelId))
            || await guild?.channels?.fetch(String(ticket?.channelId)).catch(() => null);
        if (channel?.name) return `#${channel.name}`;
    } catch { /* use stored name */ }
    if (stored) return `#${stored.replace(/^#/, '')}`;
    if (ticket?.number != null) return `#ticket-${ticket.number}`;
    return '#ticket';
}

function discordTimestamp(date, style = 'F') {
    if (!date) return '—';
    const ms = new Date(date).getTime();
    if (Number.isNaN(ms)) return '—';
    return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

module.exports = {
    NO_MENTIONS,
    creatorMentionScope,
    sanitizeMessageInput,
    neutralizeEveryone,
    safePlainText,
    displayNameOf,
    resolveUserIdentity,
    resolveTicketChannelName,
    discordTimestamp
};
