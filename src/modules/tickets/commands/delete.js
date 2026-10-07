const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const ticketRepository = require('../../../database/repositories/ticketRepository');
const { resolveTicketsConfig, getCategory } = require('../config');
const { isStaffForTicket } = require('../services/ticketService');
const { buildDeleteConfirm } = require('../services/panel');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('delete')
        .setDescription('Permanently delete this closed ticket (staff, transcript is saved first).'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            return;
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (error) {
            if (error?.code === 10062) {
                logger.warn('/delete defer skipped: interaction already expired (10062).');
            } else {
                logger.error(`/delete defer failed: ${error.stack || error}`);
            }
            return;
        }

        try {
            const ticket = await ticketRepository.getTicketByChannel(interaction.guild.id, interaction.channelId);
            if (!ticket || ticket.status === 'deleted') {
                await interaction.editReply({ content: '❌ This command can only be used inside a ticket channel.', allowedMentions: { parse: [] } });
                return;
            }
            if (ticket.status !== 'closed') {
                await interaction.editReply({ content: '❌ Only closed tickets can be deleted. Close the ticket first.', allowedMentions: { parse: [] } });
                return;
            }
            if (!isStaffForTicket(interaction.member, ticket)) {
                await interaction.editReply({ content: '❌ Only staff members can delete tickets.', allowedMentions: { parse: [] } });
                return;
            }

            const config = await resolveTicketsConfig(interaction.guild);
            const category = getCategory(config, ticket.category);
            // Reuse-only: existing confirm UI + existing IDs
            // (ticket:confirmdelete:<id> / ticket:canceldelete:<id>).
            // The existing router + destroyTicket + logging run the deletion.
            await interaction.editReply({
                ...buildDeleteConfirm(ticket, category),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            logger.error(`/delete failed: ${error.stack || error}`);
            try {
                await interaction.editReply({ content: `❌ Failed: ${error.message}`, allowedMentions: { parse: [] } });
            } catch {
                try {
                    await interaction.followUp({ content: `❌ Failed: ${error.message}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
                } catch {
                    // Response window closed — already logged above.
                }
            }
        }
    }
};
