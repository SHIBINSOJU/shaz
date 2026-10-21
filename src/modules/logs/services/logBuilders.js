// Reusable Components V2 builders for server logs. Every log message goes
// through buildLogMessage() so layout, truncation and safety rules stay in
// one place. Uses ContainerBuilder + Section/Thumbnail (no legacy embeds,
// no custom IDs, never ephemeral — the dispatcher sends public messages).
const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    FileBuilder
} = require('discord.js');

const MAX_FIELD_VALUE = 1000;
const MAX_CONTENT = 1500;

function truncate(str, max = MAX_FIELD_VALUE) {
    const s = String(str ?? '');
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1)}…`;
}

// Strip @everyone/@here pings from logged content while keeping it readable.
// The dispatcher ALSO sets allowedMentions: { parse: [] }, this is belt-and-braces.
function neutralizePings(str) {
    return String(str ?? '').replace(/@(everyone|here)/g, '@\u200b$1');
}

function safeContent(str, max = MAX_CONTENT) {
    if (str === null || str === undefined) return '_not available_';
    const s = neutralizePings(String(str));
    if (!s.trim()) return '_empty_';
    return truncate(s, max);
}

function fmtTimestamp(dateOrMs, style = 'F') {
    const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
    if (!Number.isFinite(ms)) return '_unknown_';
    return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function userLine(user, member = null) {
    if (!user) return '_unknown user_';
    const name = member?.displayName && member.displayName !== user.username
        ? `${user.tag} (${member.displayName})`
        : `${user.tag}`;
    return `${user} \`${name}\` (\`${user.id}\`)`;
}

function avatarUrlOf(user) {
    try {
        return user?.displayAvatarURL?.({ size: 128 }) || null;
    } catch {
        return null;
    }
}

/**
 * Build a public Components V2 log payload.
 * opts: { emoji, title, accent, thumbnailUrl, fields: [{label, value}], footer, fileName }
 * Fields with empty values are dropped. Values are truncated safely.
 * `fileName` must match an attachment passed via sendLog's `file` option; a
 * FileComponent is added so the uploaded transcript actually renders.
 */
function buildLogMessage({ emoji = '📋', title = 'Log', accent = BRAND_RED, thumbnailUrl = null, fields = [], footer = null, fileName = null }) {
    const container = new ContainerBuilder();
    if (accent !== null && accent !== undefined) container.setAccentColor(accent);

    const header = `## ${emoji} ${title}`;
    const lines = (fields || [])
        .filter(f => f && f.value !== undefined && f.value !== null && String(f.value) !== '')
        .map(f => `**${f.label}:** ${truncate(String(f.value), MAX_FIELD_VALUE)}`)
        .join('\n');

    const thumb = thumbnailUrl && String(thumbnailUrl).startsWith('http') ? String(thumbnailUrl) : null;

    if (thumb) {
        const section = new SectionBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lines ? `${header}\n\n${lines}` : header)
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb));
        container.addSectionComponents(section);
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
        if (lines) {
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
        }
    }

    if (footer) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${truncate(String(footer), 300)}`));
    }

    // Reference the uploaded transcript so Components V2 renders the file.
    if (fileName) {
        container.addFileComponents(new FileBuilder().setURL(`attachment://${String(fileName)}`));
    }

    return { components: [container] };
}

const { BRAND_RED } = require('../../../utils/brandColor');

module.exports = {
    buildLogMessage,
    truncate,
    safeContent,
    neutralizePings,
    fmtTimestamp,
    userLine,
    avatarUrlOf,
    MAX_FIELD_VALUE,
    MAX_CONTENT
};
