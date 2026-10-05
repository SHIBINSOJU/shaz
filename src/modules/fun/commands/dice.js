const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { randomInt } = require('crypto');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail } = require('../../utility/services/helpers');

const MIN_SIDES = 2;
const MAX_SIDES = 1000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dice')
        .setDescription('Roll a dice.')
        .addIntegerOption(option =>
            option.setName('sides')
                .setDescription(`Number of sides (default 6, max ${MAX_SIDES})`)
                .setRequired(false)
                .setMinValue(MIN_SIDES)
                .setMaxValue(MAX_SIDES)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const sides = interaction.options.getInteger('sides') ?? 6;
            const result = randomInt(1, sides + 1);
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '🎲 Dice Roll',
                    fields: [{ label: `Result (1–${sides})`, value: `**${result}**` }],
                    accent: 0xEB459E
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/dice', error);
        }
    }
};
