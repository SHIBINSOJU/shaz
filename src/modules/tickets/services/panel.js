// Components V2 payloads: ticket panel, ticket open message, close prompt.
// Panel select values are category keys; ticket buttons carry the ticket's
// database ID so every handler re-validates against MongoDB.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const crypto = require('crypto');
const { sanitizeMessageInput, safePlainText } = require('./ticketIdentity');

function hexToInt(accent) {
    if (typeof accent === 'number') return accent;
    if (typeof accent === 'string') {
        const match = accent.trim().match(/^#?([0-9a-f]{6})$/i);
        if (match) return parseInt(match[1], 16);
    }
    return 0x5865F2;
}

function buildPanel(config) {
    const panelId = crypto.randomBytes(4).toString('hex');
    const categories = Object.entries(config.categories || {});

    const container = new ContainerBuilder().setAccentColor(0x5865F2);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${config.panel.title}`)
    );
    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(config.panel.description)
    );

    const select = new StringSelectMenuBuilder()
        .setCustomId(`ticket:select:${panelId}`)
        .setPlaceholder('Select a ticket category');
    for (const [key, category] of categories) {
        const option = {
            label: String(category.name || key).slice(0, 100),
            value: key
        };
        if (category.description) option.description = String(category.description).slice(0, 100);
        if (category.emoji) option.emoji = category.emoji;
        select.addOptions(option);
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container, new ActionRowBuilder().addComponents(select)]
    };
}

function staffMentions(staffRoleIds) {
    // Role IDs come ONLY from ticket configuration (per-category
    // staffRoleIds stored on the ticket at creation). Nothing is
    // hardcoded here — no @god, no @everyone, no @here. Empty when
    // no support role is configured, so nothing is mentioned then.
    const ids = (staffRoleIds || []).map((id) => String(id).trim()).filter(Boolean);
    return ids.map((id) => `<@&${id}>`).join(' ');
}

// MENTION POLICY for this welcome message (the ONLY message in the
// entire ticket system allowed to ping):
//   - <@creatorId>: the ticket creator. Exactly one user mention.
//   - <@&roleId>: configured support roles only (see staffMentions).
// Claimed-by / closed-by lines are PLAIN TEXT (stored usernames +
// IDs) and never <@id>. User-provided reason text is sanitized so
// @everyone/@here inside it can never ping.
function buildTicketOpen(ticket, category) {
    const accent = hexToInt(category?.accent);
    const container = new ContainerBuilder().setAccentColor(accent);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## 🎫 ${category?.name || ticket.category}`)
    );
    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    const closed = ticket.status === 'closed';

    // User-provided reason is sanitized at render: @everyone/@here
    // inside it can never ping (allowedMentions scope also blocks them).
    const reason = sanitizeMessageInput(ticket.reason, 1000);
    const welcome = category?.welcomeMessage
        ? sanitizeMessageInput(category.welcomeMessage, 1000)
        : '';

    const lines = [
        `Welcome <@${ticket.userId}>!`,
        '',
        closed ? 'This ticket is currently **closed**.' : 'Your ticket has been created.',
        '',
        `**Reason:**\n${reason}`,
        ''
    ];
    if (welcome) lines.push(`${welcome}\n`);
    // Plain-text staff lines — usernames from stored snapshots, never <@id>,
    // so claim/close updates never generate notifications.
    if (ticket.claimedBy) {
        const claimName = safePlainText(ticket.claimedByUsername || ticket.claimedBy, 100);
        lines.push(`**Claimed by:** ${claimName}\n`);
    }
    if (closed) {
        if (ticket.closedBy) {
            const closeName = safePlainText(ticket.closedByUsername || ticket.closedBy, 100);
            lines.push(`**Closed by:** ${closeName}\n`);
        }
    } else {
        lines.push('A staff member will assist you shortly.');
        const mentions = staffMentions(ticket.staffRoleIds);
        if (mentions) lines.push('', mentions);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    // Same renderer, state-driven buttons: open tickets get Claim/Close,
    // closed tickets get Reopen/Delete.
    const row = closed
        ? new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket:reopen:${ticket._id}`)
                .setLabel('Reopen Ticket')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`ticket:delete:${ticket._id}`)
                .setLabel('Delete Ticket')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger)
        )
        : new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket:claim:${ticket._id}`)
                .setLabel('Claim Ticket')
                .setEmoji('🎯')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`ticket:close:${ticket._id}`)
                .setLabel('Close Ticket')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger)
        );
    container.addActionRowComponents(row);

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

function buildCloseConfirm(ticket, category) {
    // No user/role mentions here by design — plain confirm prompt.
    // The <#channel> reference is a channel link, not a user ping.
    const categoryName = sanitizeMessageInput(category?.name || ticket.category, 100);
    const container = new ContainerBuilder().setAccentColor(0xED4245);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## 🔒 Close Ticket\n\nAre you sure you want to close this ${categoryName} ticket?\n-# This will archive the ticket.`
        )
    );
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`ticket:confirmclose:${ticket._id}`)
            .setLabel('Confirm Close')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`ticket:cancelclose:${ticket._id}`)
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Secondary)
    );
    container.addActionRowComponents(row);
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

function buildTicketClosed(ticket, closedByName) {
    // Plain-text notice — never a mention. (Kept for compatibility;
    // closes now edit the ticket message in place instead.)
    const name = safePlainText(closedByName || ticket.closedByUsername || ticket.closedBy || 'A staff member', 100);
    const container = new ContainerBuilder().setAccentColor(0xED4245);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## 🔒 Ticket Closed\n\nThis ticket was closed by ${name}.\n<t:${Math.floor(Date.now() / 1000)}:F>`
        )
    );
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

function buildDeleteConfirm(ticket, category) {
    // No user/role mentions here by design — plain confirm prompt.
    const categoryName = sanitizeMessageInput(category?.name || ticket.category, 100);
    const container = new ContainerBuilder().setAccentColor(0xED4245);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## ⚠️ Delete Ticket?\n\nAre you sure you want to permanently delete this ${categoryName} ticket?\n-# This cannot be undone.`
        )
    );
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`ticket:confirmdelete:${ticket._id}`)
            .setLabel('Confirm Delete')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`ticket:canceldelete:${ticket._id}`)
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Secondary)
    );
    container.addActionRowComponents(row);
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

module.exports = {
    buildPanel,
    buildTicketOpen,
    buildCloseConfirm,
    buildDeleteConfirm,
    buildTicketClosed,
    staffMentions
};
