const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { validateTarget, sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');
const warningRepository = require('../../../database/repositories/warningRepository');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a member. Warnings are stored persistently.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member to warn').setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user');
        const reason = sanitizeReason(interaction.options.getString('reason'));

        const check = await validateTarget({
            interaction,
            targetUser,
            action: 'warn',
            permission: PermissionFlagsBits.ModerateMembers
        });
        if (!check.ok) {
            await interaction.editReply(check.error);
            return;
        }

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot be warned.');
            return;
        }

        let warning;
        let total;
        try {
            warning = await warningRepository.addWarning({
                guildId: interaction.guild.id,
                userId: targetUser.id,
                moderatorId: interaction.user.id,
                reason
            });
            const warnings = await warningRepository.getWarnings(interaction.guild.id, targetUser.id);
            total = warnings.length;
        } catch (error) {
            logger.error(`/warn database failure: ${error.message}`);
            await interaction.editReply(`❌ Could not save the warning: ${error.message}`);
            return;
        }

        await interaction.editReply(`✅ **${targetUser.tag}** has been warned (warning #${warning.warningId}).\nThey now have **${total}** warning(s).\n**Reason:** ${reason}`);

        try {
            await targetUser.send(`⚠️ You have been warned in **${interaction.guild.name}**.\n**Reason:** ${reason}`);
        } catch {
            // DMs disabled — not an error worth surfacing.
        }

        await logAction(interaction.guild, {
            title: '⚠️ Member Warned',
            accent: 0xFEE75C,
            fields: [
                { label: 'Target', value: `${targetUser} (\`${targetUser.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Warning ID', value: `#${warning.warningId}` },
                { label: 'Total warnings', value: String(total) },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
