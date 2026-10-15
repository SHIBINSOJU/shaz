// Components V2 promotion layouts (no legacy embeds — never mixed).
//
// Two immediately distinguishable designs, both branded RISE red and both
// leading with the custom RISE SMP banner artwork:
//   video -> "🎬 YOUTUBE VIDEO PREMIERE"  + "RISE NETWORK • VIDEO PROMOTION"
//   live  -> "🔴 YOUTUBE LIVESTREAM"      + "RISE NETWORK • LIVE PROMOTION"
//
// The banner is branding artwork only: the YouTube URL always stays the
// clickable destination (title link + raw URL line + link button).
//
// SuppressEmbeds is REQUIRED on the payload: the message contains the raw
// YouTube URL, and without it Discord appends an automatic link-preview
// embed that renders the YouTube thumbnail below our content — which would
// defeat the custom-banner requirement.
//
// The VERIFIED LIVE badge is only rendered when the YouTube Data API
// confirmed the stream is currently live (metadata.verifiedLive === true).
// Otherwise the message is explicitly labeled as user-submitted.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { BRAND_RED } = require('../../../utils/brandColor');

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
function buildPromoPayload({ kind, metadata, videoUrl, bannerUrl, member }) {
    const isLive = kind === 'live';
    const user = member?.user || member;
    const mention = member ? `${member}` : (user ? `${user}` : 'Unknown member');
    const displayName = neutralizeBroadcasts(user?.username || 'Unknown member');

    const title = metadata?.title ? neutralizeBroadcasts(metadata.title) : null;
    const heading = isLive ? '🔴 YOUTUBE LIVESTREAM' : '🎬 YOUTUBE VIDEO PREMIERE';
    const intro = isLive
        ? 'A member of RISE NETWORK is sharing a livestream!'
        : 'A new video has been shared by a member of RISE NETWORK!';

    const container = new ContainerBuilder().setAccentColor(BRAND_RED);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('@here')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${heading}\n${intro}`)
    );
    container.addSeparatorComponents(divider());

    const subjectLabel = isLive ? '📺 Stream' : '📺 Video';
    const subjectValue = title ? `**[${escapeMarkdown(title)}](${videoUrl})**` : `[YouTube link](${videoUrl})`;
    const creatorLabel = isLive ? '👤 Streamer' : '👤 Creator';
    const watchLabel = isLive ? '📺 Watch' : '🔗 Watch';
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

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n'))
    );
    container.addSeparatorComponents(divider());

    // Custom RISE SMP banner — branding artwork, not the video thumbnail.
    // The YouTube URL above and the button below stay the destinations.
    container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
                .setURL(bannerUrl)
                .setDescription('RISE SMP promotional banner')
        )
    );

    container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel(isLive ? '🔴 Watch Live ↗' : '▶ Watch Video ↗')
                .setStyle(ButtonStyle.Link)
                .setURL(videoUrl)
        )
    );

    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(footerLine(kind))
    );

    return {
        // SuppressEmbeds kills Discord's automatic YouTube link-preview
        // (which would render the YouTube thumbnail under our banner).
        // It never affects our explicit MediaGallery or button components.
        // NOTE: Components V2 payloads cannot use top-level `content`, so the
        // @here mention lives in the leading TextDisplay above.
        // allowedMentions is intentionally OMITTED: 'here' is not a valid
        // parse enum (valid: 'everyone' | 'users' | 'roles' — discord.js
        // 14.27.0 AllowedMentionsTypes), so parse: ['here'] throws 50035, and
        // parse: ['everyone'] would also enable @everyone (forbidden). With
        // the field omitted Discord default-parses the message, so our @here
        // pings; neutralizeBroadcasts() above guarantees no bare @everyone
        // (or second @here) can come from user-controlled title/name text.
        // (Bot still needs the Mention Everyone permission for @here to fire;
        // without it the message sends normally with no ping — never an error.)
        flags: [MessageFlags.IsComponentsV2, MessageFlags.SuppressEmbeds],
        components: [container]
    };
}

function escapeMarkdown(value) {
    return String(value).replace(/([\\_*~`|])/g, '\\$1').slice(0, 250);
}

// Breaks `@everyone` / `@here` inside user-controlled text (video titles,
// display names) so they can never ping — the same zero-width-space pattern
// used by the ticket system. Our single intentional `@here` TextDisplay below
// is added AFTER sanitization, so it stays the only bare broadcast string.
function neutralizeBroadcasts(value) {
    return String(value ?? '')
        .replace(/@everyone/gi, '@\u200beveryone')
        .replace(/@here/gi, '@\u200bhere');
}

module.exports = { buildPromoPayload, YOUTUBE_RED: BRAND_RED };
