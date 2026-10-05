const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { validateTarget, sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');

const MAX_TIMEOUT_MINUTES = 40320; // 28 days (Discord limit)

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout (mute) a member.')
        .addUserOption(option =>
            option.setName('user').setDescription('The member to timeout').setRequired(true))
        .addIntegerOption(option =>
            option.setName('minutes').setDescription('Timeout duration in minutes (1-40320)').setMinValue(1).setMaxValue(MAX_TIMEOUT_MINUTES).setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for the timeout').setRequired(false).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user');
        const minutes = interaction.options.getInteger('minutes');
        const reason = sanitizeReason(interaction.options.getString('reason'));

        const check = await validateTarget({
            interaction,
            targetUser,
            action: 'timeout',
            permission: PermissionFlagsBits.ModerateMembers
        });
        if (!check.ok) {
            await interaction.editReply(check.error);
            return;
        }

        if (check.member.communicationDisabledUntilTimestamp && check.member.communicationDisabledUntilTimestamp > Date.now()) {
            await interaction.editReply(`❌ **${check.member.displayName}** is already timed out.`);
            return;
        }

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot be timed out.');
            return;
        }

        const until = new Date(Date.now() + minutes * 60 * 1000);

        try {
            await check.member.disableCommunicationUntil(until, `${interaction.user.tag}: ${reason}`);
        } catch (error) {
            await interaction.editReply(`❌ Failed to timeout **${targetUser.tag}**: ${error.message}`);
            return;
        }

        await interaction.editReply(`✅ **${targetUser.tag}** has been timed out for **${minutes}** minute(s).\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '⏳ Member Timed Out',
            accent: 0xFEE75C,
            fields: [
                { label: 'Target', value: `${targetUser} (\`${targetUser.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Duration', value: `${minutes} minute(s)` },
                { label: 'Until', value: `<t:${Math.floor(until.getTime() / 1000)}:F>` },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
