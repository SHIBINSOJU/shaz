const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const warningRepository = require('../../../database/repositories/warningRepository');
const { buildInfoContainer } = require('../../../utils/componentsV2');

const PAGE_SIZE = 10;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('View stored warnings for a member.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member to look up (defaults to you)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.inGuild()) {
            await interaction.editReply('❌ This command can only be used inside a server.');
            return;
        }

        const targetUser = interaction.options.getUser('user') ?? interaction.user;

        let warnings;
        try {
            warnings = await warningRepository.getWarnings(interaction.guild.id, targetUser.id);
        } catch (error) {
            logger.error(`/warnings database failure: ${error.message}`);
            await interaction.editReply(`❌ Could not load warnings: ${error.message}`);
            return;
        }

        if (warnings.length === 0) {
            await interaction.editReply({
                ...buildInfoContainer({
                    header: `🟢 Warnings for ${targetUser}`,
                    fields: [{ label: 'Total', value: '0 — this member is clean.' }],
                    accent: 0x57F287
                }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            });
            return;
        }

        const shown = warnings.slice(0, PAGE_SIZE);
        const fields = shown.map(w => ({
            label: `#${w.warningId} — <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R> by <@${w.moderatorId}>`,
            value: w.reason
        }));

        const hidden = warnings.length - shown.length;
        const footer = hidden > 0
            ? `Showing latest ${PAGE_SIZE} of ${warnings.length} — use /unwarn to remove a warning by ID.`
            : `Use /unwarn to remove a warning by ID.`;

        await interaction.editReply({
            ...buildInfoContainer({
                header: `⚠️ Warnings for ${targetUser} — **${warnings.length}** total`,
                fields,
                accent: 0xFEE75C,
                footer
            }),
            flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
        });
    }
};
