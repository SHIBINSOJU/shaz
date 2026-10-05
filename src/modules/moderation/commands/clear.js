const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../services/modLogger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Bulk delete messages from this channel.')
        .addIntegerOption(option =>
            option.setName('amount').setDescription('Number of messages to delete (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
        .addUserOption(option =>
            option.setName('user').setDescription('Only delete messages from this user').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const amount = interaction.options.getInteger('amount');
        const filterUser = interaction.options.getUser('user');

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.editReply('❌ You need **Manage Messages** permission.');
            return;
        }

        if (!interaction.guild.members.me.permissionsIn(interaction.channel).has(PermissionFlagsBits.ManageMessages)) {
            await interaction.editReply('❌ I need **Manage Messages** permission in this channel.');
            return;
        }

        try {
            let deleted;
            if (filterUser) {
                // bulkDelete cannot filter, so fetch a larger window and filter manually.
                const fetched = await interaction.channel.messages.fetch({ limit: 100, before: interaction.id });
                const targets = [...fetched.values()]
                    .filter(m => m.author.id === filterUser.id && !m.system)
                    .slice(0, amount);
                deleted = await interaction.channel.bulkDelete(targets, true);
            } else {
                deleted = await interaction.channel.bulkDelete(amount, true);
            }

            if (deleted.size === 0) {
                await interaction.editReply('ℹ️ No messages matched (messages older than 14 days cannot be bulk deleted).');
                return;
            }

            await interaction.editReply(`✅ Deleted **${deleted.size}** message(s).`);

            await logAction(interaction.guild, {
                title: '🗑️ Messages Cleared',
                accent: 0xFEE75C,
                fields: [
                    { label: 'Channel', value: `${interaction.channel}` },
                    { label: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                    { label: 'Deleted', value: `${deleted.size} message(s)` },
                    ...(filterUser ? [{ label: 'Filtered user', value: `${filterUser} (\`${filterUser.id}\`)` }] : [])
                ],
                footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
            });
        } catch (error) {
            await interaction.editReply(`❌ Failed to delete messages: ${error.message}`);
        }
    }
};
