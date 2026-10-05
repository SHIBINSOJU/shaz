const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { validateTarget, sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the server.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member to ban').setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for the ban').setRequired(false).setMaxLength(500))
        .addIntegerOption(option =>
            option.setName('delete_messages').setDescription('Days of message history to delete (0-7)').setMinValue(0).setMaxValue(7).setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user');
        const reason = sanitizeReason(interaction.options.getString('reason'));
        const deleteDays = interaction.options.getInteger('delete_messages') ?? 0;

        const check = await validateTarget({
            interaction,
            targetUser,
            action: 'ban',
            permission: PermissionFlagsBits.BanMembers,
            requireMember: false
        });
        if (!check.ok) {
            await interaction.editReply(check.error);
            return;
        }

        try {
            await interaction.guild.members.ban(targetUser, {
                deleteMessageSeconds: deleteDays * 24 * 60 * 60,
                reason: `${interaction.user.tag}: ${reason}`
            });
        } catch (error) {
            await interaction.editReply(`❌ Failed to ban **${targetUser.tag}**: ${error.message}`);
            return;
        }

        await interaction.editReply(`✅ **${targetUser.tag}** has been banned.\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '🔨 Member Banned',
            accent: 0xED4245,
            fields: [
                { label: 'Target', value: `${targetUser} (\`${targetUser.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Reason', value: reason },
                { label: 'Messages deleted', value: `${deleteDays} day(s)` }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
