const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');

const SNOWFLAKE = /^\d{17,20}$/;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unban a user by their ID.')
        .addStringOption(option =>
            option.setName('user_id').setDescription('The ID of the banned user').setRequired(true))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for the unban').setRequired(false).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const userId = interaction.options.getString('user_id').trim();
        const reason = sanitizeReason(interaction.options.getString('reason'));

        if (!SNOWFLAKE.test(userId)) {
            await interaction.editReply('❌ That is not a valid user ID.');
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
            await interaction.editReply('❌ You need **Ban Members** permission.');
            return;
        }

        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
            await interaction.editReply('❌ I need **Ban Members** permission.');
            return;
        }

        try {
            await interaction.guild.bans.remove(userId, `${interaction.user.tag}: ${reason}`);
        } catch (error) {
            await interaction.editReply(`❌ Failed to unban \`${userId}\` — they may not be banned. (${error.message})`);
            return;
        }

        await interaction.editReply(`✅ User \`${userId}\` has been unbanned.\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '🔓 Member Unbanned',
            accent: 0x57F287,
            fields: [
                { label: 'Target ID', value: `\`${userId}\`` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
