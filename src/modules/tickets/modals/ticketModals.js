// Modal submit handler: ticket reason (`ticket:modal:reason:<panelId>:<category>`).
// Registered as customId prefix `ticket:modal` (prefix matching in componentHandler).

const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { resolveTicketsConfig } = require('../config');
const { createTicket } = require('../services/ticketService');

module.exports = {
    customId: 'ticket:modal',

    async handleModal(interaction) {
        try {
            if (!interaction.inGuild()) {
                await interaction.reply({ content: '❌ Tickets can only be used inside a server.', flags: MessageFlags.Ephemeral });
                return;
            }
            const parts = (interaction.customId || '').split(':');
            // ticket:modal:reason:<panelId>:<categoryKey>
            if (parts.length < 5 || parts[2] !== 'reason') return;
            const categoryKey = parts.slice(4).join(':');

            // Acknowledge BEFORE the slow work below (channel creation +
            // DB + logging can take several seconds). The modal interaction
            // owns this defer; respondOnce() finishes it exactly once.
            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (error) {
                if (error?.code === 10062) {
                    logger.warn('Ticket modal defer skipped: interaction already expired (10062).');
                } else {
                    logger.error(`Ticket modal defer failed: ${error.stack || error}`);
                }
                return;
            }

            const reason = safeField(interaction, 'reason');
            const config = await resolveTicketsConfig(interaction.guild);
            const result = await createTicket({
                client: interaction.client,
                guild: interaction.guild,
                member: interaction.member,
                categoryKey,
                reason,
                config
            });

            if (!result.ok) {
                await respondOnce(interaction, result.error);
                return;
            }

            await respondOnce(interaction, `✅ Your ticket has been created: ${result.channel}`);
        } catch (error) {
            logger.error(`Ticket modal failed (${interaction.customId}): ${error.stack || error}`);
            try {
                await respondOnce(interaction, '❌ Something went wrong creating your ticket. Please try again.');
            } catch { /* response window closed */ }
        }
    }
};

// Single owner of the modal acknowledgement: this handler replies exactly
// once. If Discord redelivers the submit (or a duplicate process already
// answered), the 40060 fallback updates the existing response instead of
// throwing a second reply.
async function respondOnce(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        if (error?.code !== 40060) throw error;
        try {
            await interaction.editReply({ content });
        } catch { /* response window closed */ }
    }
}

function safeField(interaction, name) {
    try {
        return interaction.fields.getTextInputValue(name) || '';
    } catch {
        return '';
    }
}
