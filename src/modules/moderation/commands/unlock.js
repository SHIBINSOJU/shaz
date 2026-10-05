const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { sanitizeReason } = require('../services/guards');
const { logAction } = require('../services/modLogger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock a channel so members can send messages again.')
        .addChannelOption(option =>
            option.setName('channel').setDescription('Channel to unlock (defaults to this one)').setRequired(false))
        .addStringOption(option =>
            option.setName('reason').setDescription('Reason for unlocking').setRequired(false).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        const reason = sanitizeReason(interaction.options.getString('reason'));

        if (!channel.isTextBased()) {
            await interaction.editReply('❌ You can only unlock text channels.');
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
            await interaction.editReply('❌ You need **Manage Channels** permission.');
            return;
        }

        if (!interaction.guild.members.me.permissionsIn(channel).has(PermissionFlagsBits.ManageRoles)) {
            await interaction.editReply('❌ I need **Manage Roles** permission on that channel.');
            return;
        }

        try {
            // null removes the override so the channel inherits its default permissions.
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                SendMessages: null
            }, { reason: `${interaction.user.tag}: ${reason}` });
        } catch (error) {
            await interaction.editReply(`❌ Failed to unlock ${channel}: ${error.message}`);
            return;
        }

        await interaction.editReply(`🔓 ${channel} has been unlocked.\n**Reason:** ${reason}`);

        await logAction(interaction.guild, {
            title: '🔓 Channel Unlocked',
            accent: 0x57F287,
            fields: [
                { label: 'Channel', value: `${channel} (\`${channel.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Reason', value: reason }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
