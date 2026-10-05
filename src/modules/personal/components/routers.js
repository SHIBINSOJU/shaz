// Component handlers for the personal module. Single prefix:
//   remind:cancel:<reminderId>
// Ownership is enforced by matching the reminder's stored userId against the
// clicking user — no one can cancel another user's reminder.
const { MessageFlags } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const reminderRepository = require('../../../database/repositories/reminderRepository');
const { fail } = require('../../utility/services/helpers');

async function ephemeral(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch {
        // Response window closed.
    }
}

const remindRouter = {
    customId: 'remind',
    async execute(interaction) {
        try {
            const [, action, reminderId] = (interaction.customId || '').split(':');
            if (action !== 'cancel' || !interaction.isButton()) return;
            const deleted = await reminderRepository.deleteReminder(reminderId, interaction.user.id);
            if (!deleted) {
                await ephemeral(interaction, '❌ That reminder no longer exists (or is not yours).');
                return;
            }
            try {
                if (interaction.message) {
                    await interaction.update({
                        ...buildInfoContainer({ header: '✅ Reminder cancelled.', accent: 0x57F287 }),
                        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
                    });
                    return;
                }
            } catch {
                // Fall through to ephemeral confirmation.
            }
            await ephemeral(interaction, '✅ Reminder cancelled.');
        } catch (error) {
            await fail(interaction, 'remind cancel', error);
        }
    }
};

module.exports = [remindRouter];
