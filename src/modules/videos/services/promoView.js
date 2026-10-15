// Components V2 promotion layouts (no legacy embeds — never mixed).
//
// Two immediately distinguishable designs:
//   video -> 🎬 red "YOUTUBE VIDEO PREMIERE"
//   live  -> 🔴 red "YOUTUBE LIVE STREAM" with a live-status line
//
// The VERIFIED LIVE badge is only rendered when the YouTube Data API
// confirmed the stream is currently live (metadata.verifiedLive === true).
// Otherwise the message is explicitly labeled as user-submitted.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const YOUTUBE_RED = 0xFF0000;

function divider() {
    return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function footerLine(kind) {
    return kind === 'live'
        ? '-# RISE NETWORK • LIVE PROMOTION'
        : '-# RISE NETWORK • VIDEO PROMOTION';
}

function liveStatusLine(metadata) {
    if (metadata?.verifiedLive) {
        return '🔴 **LIVE NOW** — verified live via YouTube.';
    }
    return '-# User-submitted livestream — live status not verified.';
}

/**
 * Builds the publish payload for channel.send().
 * Every field with unavailable data is omitted — no placeholders, no
 * invented titles. Creator identity always comes from the Discord member.
 */
function buildPromoPayload({ kind, metadata, videoUrl, thumbnailUrl, member }) {
    const isLive = kind === 'live';
    const user = member?.user || member;
    const mention = member ? `${member}` : (user ? `${user}` : 'Unknown member');
    const displayName = user?.username || 'Unknown member';
    const avatarUrl = typeof user?.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null;

    const title = metadata?.title || null;
    const heading = isLive ? '🔴 YOUTUBE LIVE STREAM' : '🎬 YOUTUBE VIDEO PREMIERE';
    const intro = isLive
        ? 'A member of RISE NETWORK is sharing a YouTube livestream!'
        : 'A new video has been shared by a member of RISE NETWORK!';

    const container = new ContainerBuilder().setAccentColor(YOUTUBE_RED);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${heading}\n${intro}`)
    );
    container.addSeparatorComponents(divider());

    const subjectLabel = isLive ? '🔴 Stream' : '📺 Video';
    const subjectValue = title ? `**[${escapeMarkdown(title)}](${videoUrl})**` : `[YouTube link](${videoUrl})`;
    const creatorLabel = isLive ? '👤 Streamer' : '👤 Creator';
    const watchLabel = isLive ? '📺 Watch Live' : '🔗 Watch Video';
    const lines = [
        `${subjectLabel}: ${subjectValue}`,
        `${creatorLabel}: ${mention} (\`${escapeMarkdown(displayName)}\`)`,
        `${watchLabel}: ${videoUrl}`
    ];
    if (isLive) {
        lines.push(liveStatusLine(metadata));
    } else if (metadata?.source === 'api' && metadata.liveStatus === 'upcoming') {
        lines.push('-# This video is scheduled as an upcoming premiere/stream.');
    }

    const section = new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n'))
    );
    if (avatarUrl) {
        section.setThumbnailAccessory(
            new ThumbnailBuilder().setURL(avatarUrl).setDescription(`${displayName}'s avatar`)
        );
    }
    container.addSectionComponents(section);
    container.addSeparatorComponents(divider());

    container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
                .setURL(thumbnailUrl)
                .setDescription(title || (isLive ? 'YouTube livestream thumbnail' : 'YouTube video thumbnail'))
        )
    );

    container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel(isLive ? '🔴 Watch Live' : '▶ Watch Video')
                .setStyle(ButtonStyle.Link)
                .setURL(videoUrl)
        )
    );

    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(footerLine(kind))
    );

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        allowedMentions: { parse: [] }
    };
}

function escapeMarkdown(value) {
    return String(value).replace(/([\\_*~`|])/g, '\\$1').slice(0, 250);
}

module.exports = { buildPromoPayload, YOUTUBE_RED };
