const {
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { BRAND_RED } = require('../../../utils/brandColor');

const STATUS_ACCENT = { pending: BRAND_RED, approved: 0x57F287, rejected: 0xED4245 };
const STATUS_LINE = {
    pending: '⏳ Status: Pending review',
    approved: '✅ Status: Approved',
    rejected: '❌ Status: Rejected'
};

function buildSuggestionPayload(suggestion, reviewerTag = null) {
    const container = new ContainerBuilder().setAccentColor(STATUS_ACCENT[suggestion.status] ?? BRAND_RED);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 💡 Suggestion')
    );
    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    let body = `${suggestion.content}\n\nSubmitted by: <@${suggestion.userId}>\n${STATUS_LINE[suggestion.status] ?? suggestion.status}`;
    if (suggestion.status !== 'pending' && (reviewerTag || suggestion.reviewedBy)) {
        body += `\nReviewed by: ${reviewerTag ? `${reviewerTag}` : `<@${suggestion.reviewedBy}>`}`;
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

    const components = [container];
    if (suggestion.status === 'pending') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`suggest:approve:${suggestion.suggestionId}`)
                .setLabel('👍 Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`suggest:reject:${suggestion.suggestionId}`)
                .setLabel('👎 Reject')
                .setStyle(ButtonStyle.Danger)
        );
        components.push(row);
    }

    return { flags: MessageFlags.IsComponentsV2, components };
}

module.exports = { buildSuggestionPayload };
