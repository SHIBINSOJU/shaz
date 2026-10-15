// Interactive /logs setup panel (Components V2). One container summary +
// a category picker, a channel picker and toggle/test/close buttons.
// Sessions are per-user, per-guild, expire after 10 minutes, and every
// interaction re-checks Manage Server (a stale panel never grants access).
const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags
} = require('discord.js');
const { CATEGORIES, CATEGORY_KEYS } = require('../config');
const { BRAND_RED } = require('../../../utils/brandColor');
const { getLogsConfig } = require('./logConfig');

function statusLine(cfg) {
    return CATEGORY_KEYS.map(key => {
        const meta = CATEGORIES[key];
        const c = cfg[key] || { enabled: false, channelId: null };
        const state = c.enabled ? '🟢' : '🔴';
        const dest = c.channelId ? `<#${c.channelId}>` : '_not set_';
        const mark = key === cfg._selected ? '▶ ' : '';
        return `${mark}${state} **${meta.label}** → ${dest}`;
    }).join('\n');
}

async function renderPanel(session, guild, notice = null) {
    const cfg = await getLogsConfig(guild.id);
    cfg._selected = session.selected;

    const selected = CATEGORIES[session.selected] ? session.selected : 'member';
    session.selected = selected;
    const meta = CATEGORIES[selected];
    const cur = cfg[selected] || { enabled: false, channelId: null };

    const panel = new ContainerBuilder().setAccentColor(BRAND_RED);
    panel.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 📋 Server Logs Setup')
    );
    panel.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine(cfg)));
    panel.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    panel.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**Configuring:** ${meta.emoji} ${meta.label}\n-# ${meta.description}\n**Status:** ${cur.enabled ? '🟢 Enabled' : '🔴 Disabled'} • **Channel:** ${cur.channelId ? `<#${cur.channelId}>` : '_not set_'}`
        )
    );
    if (notice) {
        panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${notice}`));
    }
    panel.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Only <@${session.userId}> can use these controls.`)
    );

    const categorySelect = new StringSelectMenuBuilder()
        .setCustomId(`logs:cat:${session.id}`)
        .setPlaceholder('Choose a log category…');
    for (const key of CATEGORY_KEYS) {
        const m = CATEGORIES[key];
        categorySelect.addOptions({
            label: `${m.label}`.slice(0, 100),
            value: key,
            description: m.description.slice(0, 100),
            emoji: m.emoji,
            default: key === selected
        });
    }

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`logs:chan:${session.id}`)
        .setPlaceholder(`Destination for ${meta.label}…`)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1);

    const rows = [
        new ActionRowBuilder().addComponents(categorySelect),
        new ActionRowBuilder().addComponents(channelSelect),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`logs:toggle:${session.id}`)
                .setLabel(cur.enabled ? 'Disable' : 'Enable')
                .setEmoji(cur.enabled ? '🔴' : '🟢')
                .setStyle(cur.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`logs:test:${session.id}`)
                .setLabel('Send test log')
                .setEmoji('📨')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`logs:close:${session.id}`)
                .setLabel('Close')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Secondary)
        )
    ];

    return { flags: MessageFlags.IsComponentsV2, components: [panel, ...rows] };
}

function buildClosed() {
    const panel = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 📋 Server Logs Setup\n\n✅ Panel closed. Run `/logs setup` to configure logging again.')
    );
    return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

function buildExpired() {
    const panel = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 📋 Server Logs Setup\n\n⏰ This setup panel has expired. Run `/logs setup` to open a new one.')
    );
    return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

module.exports = { renderPanel, buildClosed, buildExpired };
