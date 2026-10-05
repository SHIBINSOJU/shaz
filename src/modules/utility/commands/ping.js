const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check the bot latency.'),

    async execute(interaction) {
        const started = Date.now();
        await interaction.deferReply();
        try {
            const roundtrip = Date.now() - started;
            const api = interaction.client.ws.ping;
            await interaction.editReply({
                ...buildInfoContainer({
                    header: 'Pong! 🏓',
                    fields: [
                        { label: 'Bot latency', value: `${roundtrip}ms` },
                        { label: 'API latency', value: api >= 0 ? `${api}ms` : 'Unavailable' }
                    ],
                    accent: 0x57F287
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/ping', error);
        }
    }
};
