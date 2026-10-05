// Components V2 views for the /welcome configuration panel.
//
// These are pure view builders for the CONTROL PANEL. The welcome MESSAGE
// itself is always produced by the production WelcomeBuilder (including the
// preview), so the panel can never drift from what new members actually get.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags,
    escapeMarkdown
} = require('discord.js');
const WelcomeBuilder = require('./WelcomeBuilder');

const ACCENT = 0x5865F2;
const PREVIEW_MAX = 300;

// Documentation only — placeholder expansion stays in src/utils/placeholders.js.
const PLACEHOLDER_HELP = 'Placeholders: {user} {username} {displayname} {displaynameStyled} {server} {membercount} {joined} {created}';

// Every entry maps 1:1 onto an existing welcome setting; nothing is re-implemented.
const TOGGLES = {
    enabled: {
        emoji: '🎉',
        label: 'Welcome System',
        lines: [
            'Turns the automatic welcome message for new members on or off in this server.',
            'This is the same switch as `/setup welcome-toggle`.'
        ],
        value: (config) => config.enabled
    },
    thumbnailEnabled: {
        emoji: '🖼️',
        label: 'Thumbnail',
        lines: [
            'The picture shown inside the welcome **message** (the GIF, or the fallback banner image).',
            'This never changes the welcome card — they are separate features.'
        ],
        value: (config) => config.thumbnailEnabled
    },
    separatorEnabled: {
        emoji: '➖',
        label: 'Separator',
        lines: [
            'The divider lines inside the welcome message container.',
            'It is part of the message, never part of the welcome card image.'
        ],
        value: (config) => config.separatorEnabled
    },
    cardEnabled: {
        emoji: '🎨',
        label: 'Welcome Card',
        lines: [
            'The existing animated welcome card — the “Hullo!” design with the member’s name baked into the GIF.',
            'Disabled = the welcome message is sent without the card. The card itself is never redrawn.'
        ],
        value: (config) => config.cardEnabled
    },
    welcomeBots: {
        emoji: '🤖',
        label: 'Welcome Bots',
        lines: [
            'Whether to send welcome messages when a bot joins the server.',
            'Disabled = bots silently join without triggering the welcome.'
        ],
        value: (config) => config.welcomeBots
    }
};

function statusText(value) {
    return value ? '🟢 Enabled' : '🔴 Disabled';
}

function button(customId, label, emoji, style = ButtonStyle.Secondary, disabled = false) {
    const btn = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
    if (emoji) btn.setEmoji(emoji);
    if (disabled) btn.setDisabled(true);
    return btn;
}

function backRow(sessionId, ...extra) {
    return new ActionRowBuilder().addComponents(
        ...extra,
        button(`welcome:back:${sessionId}`, 'Back', '◀️')
    );
}

function text(content) {
    return new TextDisplayBuilder().setContent(content);
}

function divider() {
    return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

// Panels are always ephemeral + Components V2, so a payload can be used with
// reply(), editReply() or update() without further shaping.
function panel(container, rows) {
    return {
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
        components: [container, ...rows.filter(Boolean)]
    };
}

function plainLine(value, max = PREVIEW_MAX) {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return '_No message configured._';
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function channelLine(channel) {
    return channel ? `#${channel.name}` : '⚠️ Channel not configured';
}

function buildMainPanel({ sessionId, config, channel, dirty, notice, dbReady, openedBy }) {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents(text('## 🎉 Welcome System'));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(
        'Configure the welcome message new members receive.\n' +
        'Everything here edits this server\'s existing welcome settings.'
    ));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text([
        `**Status:** ${statusText(config.enabled)}`,
        `**Channel:** ${channelLine(channel)}`,
        `**🖼️ Thumbnail:** ${statusText(config.thumbnailEnabled)}`,
        `**➖ Separator:** ${statusText(config.separatorEnabled)}`,
        `**🎨 Welcome Card:** ${statusText(config.cardEnabled)}`,
        `**🤖 Welcome Bots:** ${statusText(config.welcomeBots)}`
    ].join('\n')));
    container.addTextDisplayComponents(text(`**📝 Message:**\n${plainLine(config.message)}`));

    if (notice) {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(text(notice));
    }

    const footerParts = [];
    if (!dbReady) footerParts.push('⚠️ The database is not connected — settings cannot be saved.');
    if (dirty) footerParts.push('🟡 You have unsaved changes — press 💾 Save to apply them.');
    footerParts.push(`-# Opened by ${escapeMarkdown(openedBy)} • ${PLACEHOLDER_HELP}`);
    container.addTextDisplayComponents(text(footerParts.join('\n')));

    const rows = [
        new ActionRowBuilder().addComponents(
            button(`welcome:field:${sessionId}:enabled`, 'Status', '🎉'),
            button(`welcome:message:${sessionId}`, 'Edit Message', '📝'),
            button(`welcome:channel:${sessionId}`, 'Set Channel', '📺'),
            button(`welcome:field:${sessionId}:thumbnailEnabled`, 'Thumbnail', '🖼️'),
            button(`welcome:field:${sessionId}:separatorEnabled`, 'Separator', '➖')
        ),
        new ActionRowBuilder().addComponents(
            button(`welcome:field:${sessionId}:cardEnabled`, 'Welcome Card', '🎨'),
            button(`welcome:field:${sessionId}:welcomeBots`, 'Welcome Bots', '🤖'),
            button(`welcome:preview:${sessionId}`, 'Preview', '🔄'),
            button(`welcome:save:${sessionId}`, 'Save', '💾', ButtonStyle.Primary, !dirty || !dbReady),
            button(`welcome:cancel:${sessionId}`, 'Cancel', '✖️', ButtonStyle.Danger)
        )
    ];

    return panel(container, rows);
}

function buildTogglePanel({ sessionId, field, config }) {
    const meta = TOGGLES[field];
    const current = Boolean(meta.value(config));

    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents(text(`## ${meta.emoji} ${meta.label}`));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(meta.lines.join('\n')));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(`**Current:** ${statusText(current)}`));

    const row = new ActionRowBuilder().addComponents(
        button(`welcome:set:${sessionId}:${field}:on`, 'Enable', '🟢', ButtonStyle.Success, current),
        button(`welcome:set:${sessionId}:${field}:off`, 'Disable', '🔴', ButtonStyle.Danger, !current),
        button(`welcome:back:${sessionId}`, 'Back', '◀️')
    );

    return panel(container, [row]);
}

function buildChannelPanel({ sessionId, config, channel }) {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents(text('## 📺 Welcome Channel'));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(
        'Where the automatic welcome message is sent. The choice is saved with 💾 Save.'
    ));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(`**Current:** ${channelLine(channel)}`));

    const select = new ChannelSelectMenuBuilder()
        .setCustomId(`welcome:chansel:${sessionId}`)
        .setPlaceholder('Select Channel')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    return panel(container, [new ActionRowBuilder().addComponents(select), backRow(sessionId)]);
}

// Simple message view with a way back into the panel.
function buildNotice({ sessionId, header, lines = [], tone = 'info' }) {
    const container = new ContainerBuilder().setAccentColor(tone === 'error' ? 0xED4245 : ACCENT);
    container.addTextDisplayComponents(text(`## ${header}`));
    const body = lines.filter(Boolean);
    if (body.length > 0) {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(text(body.join('\n')));
    }
    return panel(container, [backRow(sessionId)]);
}

function buildCancelled(openedBy) {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents(text('## 👋 Welcome panel closed'));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text(`Unsaved changes were discarded by ${escapeMarkdown(openedBy)}. Nothing was saved.`));
    return panel(container, []);
}

function buildExpired() {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents(text('## ⏰ This welcome panel has expired'));
    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(text('Run `/welcome` again to open a new one. Nothing was saved.'));
    return panel(container, []);
}

/**
 * PREVIEW — delegates to the production WelcomeBuilder with the draft layered on
 * top of the real configuration, then only appends the panel's own controls.
 * No second renderer, and the real message stays untouched.
 */
async function buildPreview({ sessionId, config, member }) {
    const payload = await WelcomeBuilder.build(member, config);
    const container = payload.components[0];
    container.addTextDisplayComponents(text(
        `-# 🔍 Preview for ${escapeMarkdown(member.displayName ?? member.user.username)} — built by the same renderer used when a member joins.`
    ));

    const rows = [
        new ActionRowBuilder().addComponents(
            button(`welcome:preview:${sessionId}`, 'Preview again', '🔄'),
            button(`welcome:back:${sessionId}`, 'Back to settings', '◀️')
        )
    ];

    return {
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
        components: [container, ...rows],
        // Same mention policy as the real welcome message: only the previewed
        // member may be pinged, never roles / @everyone / @here.
        ...(payload.allowedMentions ? { allowedMentions: payload.allowedMentions } : {}),
        ...(payload.files ? { files: payload.files } : {})
    };
}

module.exports = {
    ACCENT,
    TOGGLES,
    PLACEHOLDER_HELP,
    buildMainPanel,
    buildTogglePanel,
    buildChannelPanel,
    buildNotice,
    buildCancelled,
    buildExpired,
    buildPreview
};
