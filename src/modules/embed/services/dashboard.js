// Dashboard builder: control panel + LIVE PREVIEW in one Components V2
// message. The preview section embeds the exact output of
// renderer.buildMessage(state) — the same payload 📤 Send delivers.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const { buildMessage, hasContent } = require('./renderer');
const { describeBlock } = require('./state');

const PENDING_LABEL = {
    edit: 'Choose a block to edit…',
    remove: 'Choose a block to remove…',
    up: 'Choose a block to move up…',
    down: 'Choose a block to move down…'
};

function button(customId, label, emoji, style = ButtonStyle.Secondary) {
    const btn = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style);
    if (emoji) btn.setEmoji(emoji);
    return btn;
}

function buildDashboard(session, member = null) {
    const sid = session.id;
    const { state } = session;

    const panel = new ContainerBuilder();
    if (state.accent !== null && state.accent !== undefined) {
        panel.setAccentColor(state.accent);
    }
    panel.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🧩 Component Builder')
    );
    panel.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    panel.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `-# Only <@${session.userId}> can control this builder • Expires <t:${Math.floor(session.expiresAt / 1000)}:R> • Sends to <#${session.channelId}>`
        )
    );

    const rows = [
        new ActionRowBuilder().addComponents(
            button(`embed:header:${sid}`, 'Header', '✏️'),
            button(`embed:addtext:${sid}`, 'Add Text', '📝'),
            button(`embed:media:${sid}`, 'Media', '🖼️'),
            button(`embed:buttons:${sid}`, 'Buttons', '🔘'),
            button(`embed:style:${sid}`, 'Style', '⚙️')
        ),
        new ActionRowBuilder().addComponents(
            button(`embed:thumbnail:${sid}`, 'Thumbnail', '🖼️'),
            button(`embed:separator:${sid}`, 'Separator', '➖'),
            button(`embed:footer:${sid}`, 'Footer', '📝'),
            button(`embed:edit:${sid}`, 'Edit Block', '✏️'),
            button(`embed:remove:${sid}`, 'Remove', '🗑️', ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            button(`embed:up:${sid}`, 'Up', '⬆️'),
            button(`embed:down:${sid}`, 'Down', '⬇️'),
            button(`embed:send:${sid}`, 'Send', '📤', ButtonStyle.Success),
            button(`embed:reset:${sid}`, 'Reset', '🔄'),
            button(`embed:cancel:${sid}`, 'Cancel', '❌', ButtonStyle.Danger)
        )
    ];

    // Block picker appears only while a block-targeting action is pending.
    if (session.pendingAction && state.blocks.length > 0) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`embed:pick:${sid}`)
            .setPlaceholder(PENDING_LABEL[session.pendingAction] || 'Choose a block…');
        state.blocks.forEach((block, index) => {
            select.addOptions({
                label: describeBlock(block, index).slice(0, 100),
                value: block.id,
                description: `Type: ${block.type}`.slice(0, 100)
            });
        });
        rows.push(new ActionRowBuilder().addComponents(select));
    }

    const components = [panel, ...rows];

    components.push(new TextDisplayBuilder().setContent('## 📺 Live Preview'));

    if (hasContent(state)) {
        // The REAL message components — identical to what 📤 Send delivers.
        const preview = buildMessage(state, member);
        components.push(...preview.components);
    } else {
        components.push(new TextDisplayBuilder().setContent(
            '_Preview is empty — use the controls above to start building._'
        ));
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components
    };
}

function buildExpiredNotice() {
    const panel = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🧩 Component Builder\n\n⏰ This embed builder has expired. Run `/embed` to start a new session.')
    );
    return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

function buildCancelledNotice() {
    const panel = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🧩 Component Builder\n\n🗑️ Builder cancelled. Your draft was discarded.')
    );
    return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

module.exports = { buildDashboard, buildExpiredNotice, buildCancelledNotice };
