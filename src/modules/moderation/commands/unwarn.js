const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');
const warningRepository = require('../../../database/repositories/warningRepository');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('Remove a specific warning from a member.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member whose warning to remove').setRequired(true))
        .addIntegerOption(option =>
            option.setName('warning_id').setDescription('The warning ID to remove (see /warnings)').setMinValue(1).setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for removing the warning').setRequired(false).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user');
        const warningId = interaction.options.getInteger('warning_id');
        const reason = sanitizeReason(interaction.options.getString('reason'));

        if (!interaction.inGuild()) {
            await interaction.editReply('❌ This command can only be used inside a server.');
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.editReply('❌ You are missing permission to manage warnings.');
            return;
        }

        let removed;
        let remaining;
        try {
            removed = await warningRepository.removeWarning(interaction.guild.id, targetUser.id, warningId);
            if (!removed) {
                await interaction.editReply(`❌ **${targetUser.tag}** has no warning with ID #${warningId}.`);
                return;
            }
            const warnings = await warningRepository.getWarnings(interaction.guild.id, targetUser.id);
            remaining = warnings.length;
        } catch (error) {
            logger.error(`/unwarn database failure: ${error.message}`);
            await interaction.editReply(`❌ Could not remove the warning: ${error.message}`);
            return;
        }

        await interaction.editReply(`✅ Removed warning #${warningId} from **${targetUser.tag}**.\nThey now have **${remaining}** warning(s).\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '🧹 Warning Removed',
            accent: 0x57F287,
            fields: [
                { label: 'Target', value: `${targetUser} (\`${targetUser.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Removed warning', value: `#${warningId} — ${removed.reason}` },
                { label: 'Remaining warnings', value: String(remaining) },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
