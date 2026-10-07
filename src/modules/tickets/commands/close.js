const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const ticketRepository = require('../../../database/repositories/ticketRepository');
const { resolveTicketsConfig } = require('../config');
const { canCloseTicket, closeTicket } = require('../services/ticketService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close the ticket in the current channel.'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            return;
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (error) {
            if (error?.code === 10062) {
                logger.warn('/close defer skipped: interaction already expired (10062).');
            } else {
                logger.error(`/close defer failed: ${error.stack || error}`);
            }
            return;
        }

        try {
            const ticket = await ticketRepository.getTicketByChannel(interaction.guild.id, interaction.channelId);
            if (!ticket || ticket.status === 'deleted') {
                await interaction.editReply({ content: '❌ This command can only be used inside a ticket channel.', allowedMentions: { parse: [] } });
                return;
            }
            if (ticket.status === 'closed') {
                await interaction.editReply({ content: '❌ This ticket is already closed.', allowedMentions: { parse: [] } });
                return;
            }
            const config = await resolveTicketsConfig(interaction.guild);
            if (!canCloseTicket({ member: interaction.member, ticket, config })) {
                await interaction.editReply({ content: '❌ You do not have permission to close this ticket.', allowedMentions: { parse: [] } });
                return;
            }
            const result = await closeTicket({
                client: interaction.client,
                guild: interaction.guild,
                member: interaction.member,
                ticket,
                config
            });
            await interaction.editReply({
                content: result.ok
                    ? (result.deleted ? '✅ Ticket closed. The channel will be deleted shortly.' : '✅ Ticket closed and archived.')
                    : result.error,
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            logger.error(`/close failed: ${error.stack || error}`);
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
