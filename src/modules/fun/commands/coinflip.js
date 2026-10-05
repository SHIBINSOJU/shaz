const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { randomInt } = require('crypto');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail } = require('../../utility/services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin.'),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const result = randomInt(2) === 0 ? '🪙 Heads' : '🪙 Tails';
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '🪙 Coinflip',
                    fields: [{ label: 'Result', value: result }],
                    accent: 0xFEE75C
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/coinflip', error);
        }
    }
};
