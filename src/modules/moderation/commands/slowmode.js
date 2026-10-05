const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../services/modLogger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set the slowmode delay for a channel (0 disables it).')
        .addIntegerOption(option =>
            option.setName('seconds').setDescription('Slowmode delay in seconds (0-21600)').setMinValue(0).setMaxValue(21600).setRequired(true))
        .addChannelOption(option =>
            option.setName('channel').setDescription('Channel to configure (defaults to this one)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const seconds = interaction.options.getInteger('seconds');
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;

        if (!channel.isTextBased()) {
            await interaction.editReply('❌ Slowmode only applies to text channels.');
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
            await interaction.editReply('❌ You need **Manage Channels** permission.');
            return;
        }

        if (!interaction.guild.members.me.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
            await interaction.editReply('❌ I need **Manage Channels** permission on that channel.');
            return;
        }

        try {
            await channel.setRateLimitPerUser(seconds, `${interaction.user.tag}: slowmode ${seconds}s`);
        } catch (error) {
            await interaction.editReply(`❌ Failed to set slowmode: ${error.message}`);
            return;
        }

        const message = seconds === 0
            ? `✅ Slowmode disabled in ${channel}.`
            : `✅ Slowmode set to **${seconds}s** in ${channel}.`;
        await interaction.editReply(message);

        await logAction(interaction.guild, {
            title: '🐌 Slowmode Updated',
            accent: 0x5865F2,
            fields: [
                { label: 'Channel', value: `${channel} (\`${channel.id}\`)` },
                { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                { label: 'Delay', value: seconds === 0 ? 'disabled' : `${seconds} second(s)` }
            ],
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
    }
};
