const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const configService = require('../../../core/configService');
const afkRepository = require('../../../database/repositories/afkRepository');
const { fail, formatTimestamp } = require('../../utility/services/helpers');
const { buildInfoContainer } = require('../../../utils/componentsV2');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Mark yourself as AFK with an optional reason.')
        .addStringOption(option =>
            option.setName('reason').setDescription('Why are you going AFK?').setRequired(false).setMaxLength(500)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        try {
            if (!(configService.get('afk.enabled', true))) {
                await interaction.editReply({ content: '❌ The AFK system is disabled.' });
                return;
            }
            const reason = (interaction.options.getString('reason') ?? 'AFK').trim() || 'AFK';
            await afkRepository.setAfk(interaction.guild.id, interaction.user.id, reason);
            await interaction.editReply({
                ...buildInfoContainer({
                    header: `💤 ${interaction.user.username} is now AFK`,
                    fields: [
                        { label: 'Reason', value: reason },
                        { label: 'Since', value: formatTimestamp(new Date()) }
                    ],
                    accent: 0xFEE75C
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/afk', error, '❌ Could not set your AFK status. Is the database connected?');
        }
    }
};
