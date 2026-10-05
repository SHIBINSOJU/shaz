const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { validateTarget, sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member from the server.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member to kick').setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for the kick').setRequired(false).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user');
        const reason = sanitizeReason(interaction.options.getString('reason'));

        const check = await validateTarget({
            interaction,
            targetUser,
            action: 'kick',
            permission: PermissionFlagsBits.KickMembers
        });
        if (!check.ok) {
            await interaction.editReply(check.error);
            return;
        }

        try {
            await check.member.kick(`${interaction.user.tag}: ${reason}`);
        } catch (error) {
            await interaction.editReply(`❌ Failed to kick **${targetUser.tag}**: ${error.message}`);
            return;
        }

        await interaction.editReply(`✅ **${targetUser.tag}** has been kicked.\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '👢 Member Kicked',
            accent: 0xFEE75C,
            fields: [
                { label: 'Target', value: `${targetUser} (\`${targetUser.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
