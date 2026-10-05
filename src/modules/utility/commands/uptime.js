const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail, formatDuration, formatTimestamp } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('uptime')
        .setDescription("Show how long the bot has been online."),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const uptimeMs = interaction.client.uptime ?? process.uptime() * 1000;
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '🟢 Shaz Uptime',
                    fields: [
                        { label: 'Uptime', value: formatDuration(uptimeMs) },
                        { label: 'Started', value: formatTimestamp(new Date(Date.now() - uptimeMs)) }
                    ],
                    accent: 0x57F287
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/uptime', error);
        }
    }
};
