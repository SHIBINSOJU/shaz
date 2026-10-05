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
const { formatTimestamp } = require('../../utility/services/helpers');

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function buildPollPayload(poll) {
    const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
    const lines = poll.options.map((option, index) => {
        const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(percent / 10)) + '░'.repeat(10 - Math.round(percent / 10));
        return `${NUMBER_EMOJI[index] ?? `${index + 1}.`} **${option.label}**\n${bar} ${option.votes} vote${option.votes === 1 ? '' : 's'} (${percent}%)`;
    });

    const footer = poll.closed
        ? `📊 Poll closed — ${total} total vote${total === 1 ? '' : 's'}`
        : poll.endsAt
            ? `📊 ${total} vote${total === 1 ? '' : 's'} so far — ends ${formatTimestamp(poll.endsAt)}`
            : `📊 ${total} vote${total === 1 ? '' : 's'} so far`;

    const container = new ContainerBuilder().setAccentColor(poll.closed ? 0x808080 : 0x5865F2);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## 📊 ${poll.question}`)
    );
    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')));
    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));

    const components = [container];
    if (!poll.closed) {
        const row = new ActionRowBuilder().addComponents(
            ...poll.options.map((option, index) =>
                new ButtonBuilder()
                    .setCustomId(`poll:vote:${poll.pollId}:${index}`)
                    .setLabel(option.label.slice(0, 80))
                    .setStyle(ButtonStyle.Primary)
            )
        );
        components.push(row);
    }

    return { flags: MessageFlags.IsComponentsV2, components };
}

module.exports = { buildPollPayload };
