const { SlashCommandBuilder } = require('discord.js');
const { getMinecraftConfig, buildIpResponse } = require('../services/minecraftService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverip')
        .setDescription('Get the Minecraft server connection address for Java and Bedrock.')
        .addStringOption(option =>
            option.setName('edition')
                .setDescription('Filter by Minecraft edition (Java or Bedrock)')
                .setRequired(false)
                .addChoices(
                    { name: 'Both (Java & Bedrock)', value: 'all' },
                    { name: '☕ Java Edition', value: 'java' },
                    { name: '🪨 Bedrock Edition', value: 'bedrock' }
                )
        ),

    async execute(interaction) {
        const edition = interaction.options.getString('edition') || 'all';
        const config = getMinecraftConfig();
        // buildIpResponse() already carries [IsComponentsV2, Ephemeral]:
        // the addresses stay private to whoever ran the command.
        const payload = buildIpResponse(config, edition);
        await interaction.reply(payload);
    }
};
