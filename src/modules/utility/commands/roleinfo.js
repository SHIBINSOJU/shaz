const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail, formatTimestamp } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roleinfo')
        .setDescription('Show information about a role.')
        .addRoleOption(option =>
            option.setName('role').setDescription('Which role (defaults to your highest role)').setRequired(false)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        try {
            const fallback = [...interaction.member.roles.cache.values()]
                .filter(r => r.id !== interaction.guild.id)
                .sort((a, b) => b.position - a.position)[0] ?? null;
            const role = interaction.options.getRole('role') ?? fallback;
            if (!role) {
                await interaction.editReply({ content: '❌ You have no roles to show. Specify a role instead.' });
                return;
            }

            await interaction.editReply({
                ...buildInfoContainer({
                    header: `🎭 ${role.name}`,
                    fields: [
                        { label: 'Role', value: `${role}` },
                        { label: 'Role ID', value: `\`${role.id}\`` },
                        { label: 'Color', value: role.hexColor !== '#000000' ? role.hexColor : 'Default (no color)' },
                        { label: 'Position', value: `${role.position}` },
                        { label: 'Members', value: `${role.members.size}` },
                        { label: 'Mentionable', value: role.mentionable ? 'Yes' : 'No' },
                        { label: 'Displayed separately (hoisted)', value: role.hoist ? 'Yes' : 'No' },
                        { label: 'Created', value: formatTimestamp(role.createdAt) }
                    ],
                    accent: role.color !== 0 ? role.color : 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/roleinfo', error);
        }
    }
};
