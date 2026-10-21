// Manual server-status announcement builder for /serverstatus.
// Renders ONE Components V2 Container (title -> separator -> announcement ->
// status GIF media gallery -> separator -> branding footer) for RISE SMP.
// Mirrors the conventions in statusView.js: Containers only (never legacy
// embeds), shared BRAND_RED accent, and the permanent CDN status GIFs.
//
// The GIFs are the same RISE SMP status assets used by statusView.js, referenced
// by their stable CDN path. Discord's signed `?ex=…&is=…&hm=…` query params are
// short-lived and would freeze the media once expired, so they are intentionally
// omitted here exactly as in statusView.js — the base URL renders indefinitely.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags
} = require('discord.js');
const { BRAND_RED } = require('../../../utils/brandColor');

// Status keys are the exact slash-command choice values.
const STATUS_CHOICES = {
    online: 'Online',
    offline: 'Offline',
    maintenance: 'Maintenance'
};

const STATUS_ASSETS = {
    online: {
        title: '🟢 SERVER BACK ONLINE',
        body: [
            '**RISE SMP is back online!**',
            '',
            'The server is up and ready to play. Jump in! 🎉',
            '',
            'Thank you for your patience and continued support. ❤️'
        ].join('\n'),
        // standard_1.gif
        mediaUrl: 'https://cdn.discordapp.com/attachments/1476627383493591152/1556629556197204001/standard_1.gif',
        accent: 0x57F287
    },
    offline: {
        title: '🔴 SERVER OFFLINE',
        body: [
            '**RISE SMP is currently offline.**',
            '',
            'We are aware of the issue and are working to restore the server as soon as possible.',
            '',
            'Thank you for your patience. ❤️'
        ].join('\n'),
        // standard_2.gif
        mediaUrl: 'https://cdn.discordapp.com/attachments/1476627383493591152/1556629725504602273/standard_2.gif',
        accent: 0xED4245
    },
    maintenance: {
        title: '🔧 SERVER UNDER MAINTENANCE',
        body: [
            '**The server is currently undergoing maintenance.**',
            '',
            'We are working to improve the server and hope to have it back online soon!',
            '',
            'Thank you for your patience and understanding. ❤️'
        ].join('\n'),
        // standard_3.gif
        mediaUrl: 'https://cdn.discordapp.com/attachments/1476627383493591152/1556629656935993364/standard_3.gif',
        accent: 0xFEE75C
    }
};

function isValidStatus(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_ASSETS, status);
}

/**
 * Build the Components V2 announcement payload for a status.
 * {
 *   status,                      // 'online' | 'offline' | 'maintenance'
 *   serverName = 'RISE SMP',
 *   roleMention = null,          // raw '<@&id>' string, or null for no ping
 *   accent = null                // optional override; defaults per status
 * }
 * Returns { flags, components, allowedMentions }. The role mention lives INSIDE
 * the container (a TextDisplay) — Components V2 messages must not use `content`.
 */
function buildStatusAnnouncement({ status, serverName = 'RISE SMP', roleMention = null, accent = null }) {
    const asset = STATUS_ASSETS[status] || STATUS_ASSETS.online;
    const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

    const container = new ContainerBuilder().setAccentColor(accent ?? asset.accent ?? BRAND_RED);

    // Title
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${asset.title}`));
    container.addSeparatorComponents(divider());

    // Announcement body (+ optional role ping at the top, so it notifies).
    const body = roleMention ? `${roleMention}\n\n${asset.body}` : asset.body;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

    // Status GIF media gallery
    container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(asset.mediaUrl).setDescription(asset.title)
        )
    );

    // Branding footer
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${serverName} • Server Status System`
    ));

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        // Notify ONLY the intended role; never @everyone/@here. repliedUser is
        // irrelevant here (we send via channel.send), but kept false defensively.
        allowedMentions: roleMention
            ? { roles: [roleMention.replace(/\D/g, '')], parse: ['roles'], repliedUser: false }
            : { parse: [], repliedUser: false }
    };
}

module.exports = { STATUS_CHOICES, STATUS_ASSETS, isValidStatus, buildStatusAnnouncement };
