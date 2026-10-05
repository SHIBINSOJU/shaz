const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags
} = require('discord.js');

/**
 * Builds a Components V2 message payload (no embeds).
 * header: markdown heading line. fields: array of { label, value } lines.
 * accent: optional hex/number accent color.
 */
function buildInfoContainer({ header, fields = [], accent = null, footer = null }) {
    const container = new ContainerBuilder();
    if (accent !== null && accent !== undefined) container.setAccentColor(accent);

    if (header) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    }

    if (fields.length > 0) {
        const lines = fields
            .filter(f => f && f.value !== undefined && f.value !== null && f.value !== '')
            .map(f => `**${f.label}:** ${f.value}`)
            .join('\n');
        if (lines) {
            if (header) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
            }
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
        }
    }

    if (footer) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

module.exports = { buildInfoContainer };
