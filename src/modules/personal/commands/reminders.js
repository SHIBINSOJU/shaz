const {
    SlashCommandBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const reminderRepository = require('../../../database/repositories/reminderRepository');
const { fail, formatTimestamp } = require('../../utility/services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reminders')
        .setDescription('List your active reminders (with cancel buttons).'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const reminders = await reminderRepository.getUserReminders(interaction.guild.id, interaction.user.id);
            if (reminders.length === 0) {
                await interaction.editReply({ content: '📭 You have no active reminders. Create one with `/remind`.' });
                return;
            }

            const container = new ContainerBuilder().setAccentColor(0x5865F2);
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## ⏰ Your reminders (${reminders.length})`)
            );
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    reminders.map((r, i) => `**${i + 1}.** ${r.message}\n-# Due ${formatTimestamp(r.remindAt)}`).join('\n\n')
                )
            );

            // One row of cancel buttons (max 5 shown with buttons; rest listed).
            const withButtons = reminders.slice(0, 5);
            const row = new ActionRowBuilder().addComponents(
                ...withButtons.map((r, i) =>
                    new ButtonBuilder()
                        .setCustomId(`remind:cancel:${r._id}`)
                        .setLabel(`Cancel #${i + 1}`)
                        .setStyle(ButtonStyle.Danger)
                )
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container, row]
            });
        } catch (error) {
            await fail(interaction, '/reminders', error);
        }
    }
};
