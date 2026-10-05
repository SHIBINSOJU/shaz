const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail, countMembers } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('membercount')
        .setDescription('Show the member breakdown of this server.'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        try {
            const { total, bots, humans } = await countMembers(interaction.guild);
            await interaction.editReply({
                ...buildInfoContainer({
                    header: `👥 ${interaction.guild.name}`,
                    fields: [
                        { label: '👥 Total Members', value: `${total}` },
                        { label: '🤖 Bots', value: `${bots}` },
                        { label: '👤 Humans', value: `${humans}` }
                    ],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/membercount', error);
        }
    }
};
