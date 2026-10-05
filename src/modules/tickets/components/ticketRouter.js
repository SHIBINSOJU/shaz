// Single router for all `ticket:*` buttons and the panel select menu.
// Registered as customId prefix `ticket` (see componentHandler prefix matching).
// Every action re-validates guild, ticket (from MongoDB), permissions,
// ownership, and status — custom IDs alone are never trusted.
//
// ACKNOWLEDGEMENT ARCHITECTURE (exactly once per interaction):
// - interactionCreate.js NEVER acks; it only routes. This router owns the ack.
// - Slow handlers (claim/close/reopen/delete + both confirm prompts) call
//   deferReply({ ephemeral: true }) FIRST, then do DB/permission/Discord
//   work, then finish with exactly one editReply.
// - Fast cancel handlers ack with exactly one interaction.update() (edits the
//   confirm UI away) and never defer.
// - `ephemeral()` is only a fallback: reply if untouched, followUp if the
//   interaction was already acknowledged. It never double-acks.
// - The top-level catch-all answers via ephemeral() so no exception leaves an
//   interaction unanswered ("didn't respond in time") or throws 40060.

const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags
} = require('discord.js');
const logger = require('../../../core/logger');
const ticketRepository = require('../../../database/repositories/ticketRepository');
const { resolveTicketsConfig, getCategory } = require('../config');
const {
    isStaffForTicket,
    canCloseTicket,
    canClaimTicket,
    closeTicket,
    reopenTicket,
    destroyTicket,
    claimTicket,
    REASON_MIN,
    REASON_MAX
} = require('../services/ticketService');
const { buildCloseConfirm, buildDeleteConfirm } = require('../services/panel');
const { buildInfoContainer } = require('../../../utils/componentsV2');

// Acknowledge immediately. Returns true when the handler may continue,
// false when the interaction token is already expired (10062) and nothing
// can answer it — handlers must return right away in that case.
async function ackFirst(interaction, label) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return true;
    } catch (error) {
        if (error?.code === 10062) {
            logger.warn(`Ticket ${label} defer skipped: interaction already expired (10062).`);
        } else {
            logger.error(`Ticket ${label} defer failed: ${error.stack || error}`);
        }
        return false;
    }
}

// Finish an already-deferred interaction exactly once.
async function answer(interaction, content) {
    try {
        await interaction.editReply({ content });
    } catch {
        try {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } catch { /* response window closed */ }
    }
}

// Finish an already-deferred interaction with a rich (Components V2) payload.
async function answerPayload(interaction, payload) {
    try {
        await interaction.editReply(payload);
    } catch {
        try {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } catch { /* response window closed */ }
    }
}

async function ephemeral(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch { /* response window closed */ }
}

async function loadTicketOrWarn(interaction, ticketId) {
    const ticket = await ticketRepository.getTicketById(ticketId);
    if (!ticket || ticket.status === 'deleted') {
        await ephemeral(interaction, '❌ This ticket no longer exists.');
        return null;
    }
    if (String(ticket.guildId) !== String(interaction.guildId)) {
        await ephemeral(interaction, '❌ This ticket belongs to another server.');
        return null;
    }
    return ticket;
}

module.exports = {
    customId: 'ticket',

    async execute(interaction) {
        try {
            if (!interaction.inGuild()) {
                await ephemeral(interaction, '❌ Tickets can only be used inside a server.');
                return;
            }
            const parts = (interaction.customId || '').split(':');
            if (parts[0] !== 'ticket' || parts.length < 3) return;

            const action = parts[1];

            // Panel select: ticket:select:<panelId> — value is the category key.
            if (action === 'select') {
                await handleSelect(interaction);
                return;
            }

            const ticketId = parts[2];
            switch (action) {
                case 'claim': return await handleClaim(interaction, ticketId);
                case 'close': return await handleCloseAsk(interaction, ticketId);
                case 'confirmclose': return await handleCloseConfirm(interaction, ticketId);
                case 'cancelclose': return await handleCloseCancel(interaction, ticketId);
                case 'reopen': return await handleReopen(interaction, ticketId);
                case 'delete': return await handleDeleteAsk(interaction, ticketId);
                case 'confirmdelete': return await handleDeleteConfirm(interaction, ticketId);
                case 'canceldelete': return await handleDeleteCancel(interaction, ticketId);
                default: break;
            }
        } catch (error) {
            logger.error(`Ticket button failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeral(interaction, '❌ Something went wrong. Please try again.');
        }
    }
};

async function handleSelect(interaction) {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.user.bot) return;
    const categoryKey = interaction.values?.[0];
    const config = await resolveTicketsConfig(interaction.guild);

    if (!config.enabled) {
        await ephemeral(interaction, '❌ The ticket system is currently disabled.');
        return;
    }
    const category = getCategory(config, categoryKey);
    if (!category) {
        await ephemeral(interaction, '❌ That ticket category no longer exists.');
        return;
    }

    // Select-menu interactions cannot be deferred before showModal — the
    // modal itself IS the acknowledgement and must be shown within ~3s.
    // All slow work (channel creation) happens after the modal submit.
    const modal = new ModalBuilder()
        .setCustomId(`ticket:modal:reason:${interaction.customId.split(':')[2]}:${categoryKey}`)
        .setTitle(`Open Ticket — ${category.name}`.slice(0, 45));
    const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for opening this ticket')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(REASON_MIN)
        .setMaxLength(REASON_MAX)
        .setPlaceholder('Explain why you need support...');
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    try {
        await interaction.showModal(modal);
    } catch (error) {
        if (error?.code !== 40060 && error?.code !== 10062) {
            logger.error(`Ticket select showModal failed: ${error.stack || error}`);
        }
        await ephemeral(interaction, '❌ Could not open the ticket form. Please try again.');
    }
}

async function handleClaim(interaction, ticketId) {
    if (!await ackFirst(interaction, 'claim')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    const config = await resolveTicketsConfig(interaction.guild);

    if (!canClaimTicket({ member: interaction.member, ticket, guild: interaction.guild })) {
        await answer(interaction, '❌ You cannot claim this ticket.\nOnly ticket staff and administrators can claim tickets.');
        return;
    }

    // claimTicket edits the ticket message in place; this interaction only
    // needs its own deferred response finished (never interaction.update()
    // after a defer — that combination throws).
    const result = await claimTicket({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    await answer(interaction, result.ok
        ? `✅ You claimed ticket \`#${ticket.number}\`.`
        : result.error);
}

async function handleCloseAsk(interaction, ticketId) {
    if (!await ackFirst(interaction, 'close-ask')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    if (ticket.status === 'closed') {
        await answer(interaction, '❌ This ticket is already closed.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    if (!canCloseTicket({ member: interaction.member, ticket, config })) {
        await answer(interaction, '❌ You do not have permission to close this ticket.');
        return;
    }
    const category = getCategory(config, ticket.category);
    await answerPayload(interaction, {
        ...buildCloseConfirm(ticket, category),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function handleCloseConfirm(interaction, ticketId) {
    if (!await ackFirst(interaction, 'close-confirm')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    if (ticket.status === 'closed') {
        await answer(interaction, '❌ This ticket is already closed.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    if (!canCloseTicket({ member: interaction.member, ticket, config })) {
        await answer(interaction, '❌ You do not have permission to close this ticket.');
        return;
    }
    const result = await closeTicket({
        client: interaction.client,
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    await answer(interaction, result.ok
        ? (result.deleted
            ? '✅ Ticket closed. The channel will be deleted shortly.'
            : '✅ Ticket closed and archived.')
        : result.error);
}

async function handleReopen(interaction, ticketId) {
    if (!await ackFirst(interaction, 'reopen')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    if (ticket.status !== 'closed') {
        await answer(interaction, '❌ Only closed tickets can be reopened.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    const result = await reopenTicket({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    // Single ack: the service already edited the ticket message in place,
    // so this only finishes the deferred response (never update+edit).
    await answer(interaction, result.ok
        ? `✅ Ticket \`#${ticket.number}\` reopened.`
        : result.error);
}

async function handleDeleteAsk(interaction, ticketId) {
    if (!await ackFirst(interaction, 'delete-ask')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    if (ticket.status !== 'closed') {
        await answer(interaction, '❌ Only closed tickets can be deleted. Close the ticket first.');
        return;
    }
    if (!isStaffForTicket(interaction.member, ticket)) {
        await answer(interaction, '❌ Only staff members can delete tickets.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    const category = getCategory(config, ticket.category);
    await answerPayload(interaction, {
        ...buildDeleteConfirm(ticket, category),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function handleDeleteConfirm(interaction, ticketId) {
    if (!await ackFirst(interaction, 'delete-confirm')) return;
    const ticket = await loadTicketOrWarn(interaction, ticketId);
    if (!ticket) return;
    const config = await resolveTicketsConfig(interaction.guild);
    // destroyTicket owns the full order: fetch ALL messages -> transcript ->
    // upload -> deleted log -> mark deleted. It returns ok:false (and keeps
    // the channel) when the transcript or log write fails, so the channel
    // below is deleted ONLY after the archive verifiably exists.
    const result = await destroyTicket({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    if (!result.ok) {
        await answer(interaction, result.error);
        return;
    }
    // Respond BEFORE the channel is gone: the interaction response lives in
    // this channel, so deleting first would orphan it.
    await answer(interaction, result.transcript
        ? `✅ Ticket \`#${ticket.number}\` permanently deleted. Transcript uploaded: ${result.transcript}${result.transcriptUrl ? `\n${result.transcriptUrl}` : ''}`
        : `✅ Ticket \`#${ticket.number}\` permanently deleted. Deletion logged.`);
    if (result.channel) {
        await result.channel.delete('Ticket permanently deleted').catch(() => {});
    }
}

async function handleDeleteCancel(interaction, ticketId) {
    try {
        if (interaction.isButton() && interaction.message) {
            // Single ack via update: edits the confirm UI away. Stay on
            // Components V2 — editing a V2 message back to legacy content
            // is rejected by Discord, same as the reverse.
            await interaction.update({
                ...buildInfoContainer({
                    header: 'Delete cancelled',
                    fields: [{ label: 'Note', value: 'The ticket was not deleted.' }],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            });
            return;
        }
    } catch { /* fall through */ }
    await ephemeral(interaction, 'Delete cancelled — the ticket was not deleted.');
}

async function handleCloseCancel(interaction, ticketId) {
    try {
        if (interaction.isButton() && interaction.message) {
            // Single ack via update: edits the confirm UI away. Stay on
            // Components V2 — editing a V2 message back to legacy content
            // is rejected by Discord, same as the reverse.
            await interaction.update({
                ...buildInfoContainer({
                    header: 'Close cancelled',
                    fields: [{ label: 'Note', value: 'The ticket stays open.' }],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            });
            return;
        }
    } catch { /* fall through */ }
    await ephemeral(interaction, 'Close cancelled — the ticket stays open.');
}
