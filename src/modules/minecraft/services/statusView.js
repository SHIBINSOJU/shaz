const {
    AttachmentBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags
} = require('discord.js');
const { BEDROCK_DEFAULT_IP, BEDROCK_DEFAULT_PORT } = require('./minecraftService');

// PUBLIC single-server /mcstatus view: ONE combined RISE SMP status rendered
// as a Components V2 Container (never a traditional embed). The thumbnail is
// the live Minecraft server favicon attached to the message — never the bot
// avatar. Uptime is DETECTED uptime (now - first-seen-online), labelled as such
// because the exact server boot time cannot be determined from a status ping.
const STATUS_FLAGS = [MessageFlags.IsComponentsV2];
const EPHEMERAL_STATUS_FLAGS = [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral];
const NO_MENTIONS = { parse: [], repliedUser: false };

const MAX_NAMES = 20;
const FAVICON_FILENAME = 'server-favicon.png';
const FAVICON_URL = `attachment://${FAVICON_FILENAME}`;

// Status banner GIFs, shown as actual media (never clickable links) at the
// BOTTOM of the status Container. URL-based, so switching online<->offline
// never uploads anything — the rendered GIF simply follows the server state.
const ONLINE_GIF_URL = 'https://cdn.discordapp.com/attachments/1476627383493591152/1556629556197204001/standard_1.gif';
const OFFLINE_GIF_URL = 'https://cdn.discordapp.com/attachments/1476627383493591152/1556629725504602273/standard_2.gif';

function stripCodes(text) {
    return String(text ?? '').replace(/§[0-9a-fk-or]/gi, '').trim();
}

function formatUptime(ms) {
    if (!ms || ms <= 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (!days && !hours && parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ') || '<1m';
}

function relativeTimestamp(date) {
    if (!date) return 'never';
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

function absoluteTimestamp(date) {
    if (!date) return 'never';
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:f>`;
}

function statusBadge(online) {
    return online ? '🟢 Online' : '🔴 Offline';
}

function namesLine(snapshot) {
    if (!snapshot.online) return '—';
    const names = (snapshot.players?.names || []).filter(Boolean);
    if (names.length === 0) {
        return snapshot.players?.online > 0 ? '_Hidden by server_' : '_No players online_';
    }
    const shown = names.slice(0, MAX_NAMES).map((n) => `\`${stripCodes(n)}\``).join(', ');
    const extra = names.length > MAX_NAMES ? ` _(+${names.length - MAX_NAMES} more)_` : '';
    return shown + extra;
}

/** Decodes the Java favicon data URL into an attachable PNG buffer. */
function faviconAttachment(favicon) {
    if (typeof favicon !== 'string') return null;
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(favicon.trim());
    if (!match) return null;
    try {
        const buffer = Buffer.from(match[1], 'base64');
        // A real favicon PNG is typically several KB; reject garbage before attaching.
        if (buffer.length < 50 || buffer.length > 512 * 1024) return null;
        return new AttachmentBuilder(buffer, { name: FAVICON_FILENAME });
    } catch {
        return null;
    }
}

function actionRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mc:status:refresh')
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mc:status:players')
            .setLabel('👥 Players')
            .setStyle(ButtonStyle.Secondary)
    );
}

/**
 * Builds the PUBLIC single-server Components V2 reply from a combined monitor
 * snapshot. Java/Bedrock are already merged by the monitor — this view renders
 * exactly ONE server block. Returns { flags, components, files, allowedMentions }.
 */
function buildStatusResponse(snapshot, { throttled = false } = {}) {
    const online = Boolean(snapshot.online);
    const playersOnline = Number(snapshot.players?.online) || 0;
    const playersMax = Number(snapshot.players?.max) || 0;
    const version = online ? (stripCodes(snapshot.version) || 'Unknown') : '—';
    const ping = online && snapshot.ping != null ? `${snapshot.ping}ms` : '—';
    const files = [];
    const attachment = faviconAttachment(snapshot.favicon);
    if (attachment && online) files.push(attachment);
    const hasThumbnail = files.length > 0;

    const container = new ContainerBuilder().setAccentColor(snapshot.accentColor ?? 0x5865F2);
    const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

    const headerText = `## 🎮 ${snapshot.serverName || 'RISE SMP'}\n${statusBadge(online)}`;
    if (hasThumbnail) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(FAVICON_URL))
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }

    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        [
            `👥 **Players:** ${playersOnline}/${playersMax}`,
            `🧱 **Minecraft version:** ${version}`,
            `⚡ **Ping:** ${ping}`,
            `⏱️ **Minecraft server uptime:** ${online ? `${formatUptime(snapshot.uptimeMs)} (detected)` : '—'}`,
            `🕐 **Last checked:** ${relativeTimestamp(snapshot.lastChecked)}`
        ].join('\n')
    ));

    container.addSeparatorComponents(divider());
    // Server address is ALWAYS separate IP and Port fields (Bedrock-safe):
    // never `host:port`. Uses the snapshot host/port (same values queried for
    // both Java and Bedrock) with centralized defaults.
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `🌐 **Server address:**\nIP: \`${snapshot.host || BEDROCK_DEFAULT_IP}\`\nPort: \`${snapshot.port || BEDROCK_DEFAULT_PORT}\``
    ));

    container.addSeparatorComponents(divider());
    const note = throttled
        ? '-# 🔄 Refreshed too soon — showing the latest cached status.'
        : '-# Auto-updates in place — this message is edited on every refresh.';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(note));

    // Buttons live INSIDE the Container (above the GIF), so the whole panel —
    // fields, buttons, banner — is one top-level component that gets edited in
    // place on every refresh.
    container.addActionRowComponents(actionRow());

    // Status banner LAST: ONLINE GIF when the server answers, OFFLINE GIF when
    // it does not. The favicon thumbnail above is untouched by this.
    container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(online ? ONLINE_GIF_URL : OFFLINE_GIF_URL)
        )
    );

    return {
        flags: STATUS_FLAGS,
        components: [container],
        files,
        allowedMentions: NO_MENTIONS
    };
}

/**
 * Builds the PRIVATE player-list reply for the 👥 Players button. Ephemeral
 * Components V2 Container with the COMPLETE cached name list (never capped at
 * the main panel's preview size). Never posted publicly, never edits the main
 * status message — sent as a fresh ephemeral reply to the button click.
 */
function buildPlayersResponse(snapshot) {
    const online = Boolean(snapshot.online);
    const playersOnline = Number(snapshot.players?.online) || 0;
    const playersMax = Number(snapshot.players?.max) || 0;

    const container = new ContainerBuilder().setAccentColor(snapshot.accentColor ?? 0x5865F2);

    let body;
    if (!online) {
        body = `## 👥 Players — ${snapshot.serverName || 'RISE SMP'}\n🔴 Offline\n\n_No players online (server is offline)._`;
    } else {
        const names = (snapshot.players?.names || []).filter(Boolean);
        let list;
        if (names.length === 0) {
            list = playersOnline > 0 ? '_Player names hidden by server_' : '_No players online_';
        } else {
            list = names.map((n) => `\`${stripCodes(n)}\``).join(', ');
            const hidden = playersOnline - names.length;
            if (hidden > 0) list += ` _(+${hidden} more — not exposed by server)_`;
        }
        body = `## 👥 Players — ${snapshot.serverName || 'RISE SMP'}\n**${playersOnline}/${playersMax} online**\n\n${list}`;
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '-# 🔒 Private view — only you can see this message.'
    ));

    return {
        flags: EPHEMERAL_STATUS_FLAGS,
        components: [container],
        files: [],
        allowedMentions: NO_MENTIONS
    };
}

module.exports = { buildStatusResponse, buildPlayersResponse, formatUptime, absoluteTimestamp, _internal: { stripCodes, namesLine, faviconAttachment } };
