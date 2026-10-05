const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType
} = require('discord.js');
const logger = require('../../../core/logger');
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const ticketRepository = require('../../../database/repositories/ticketRepository');
const { resolveTicketsConfig, getCategory } = require('../config');
const { buildPanel } = require('../services/panel');
const {
    isStaffForTicket,
    canCloseTicket,
    canClaimTicket,
    closeTicket,
    claimTicket,
    destroyTicket,
    sendTranscript,
    renameTicket,
    setMemberAccess
} = require('../services/ticketService');
const { logTicket } = require('../services/ticketLogger');
const { safePlainText, resolveTicketChannelName } = require('../services/ticketIdentity');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Professional ticket system (panels, claims, closing, and more).')
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('Configure the ticket system for this server (admin).')
            .addChannelOption(o => o.setName('panel-channel').setDescription('Default channel for /ticket panel (omit to keep)').setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addChannelOption(o => o.setName('log-channel').setDescription('Ticket log channel (omit to keep)').setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addBooleanOption(o => o.setName('log-toggle').setDescription('Enable or disable ticket logging').setRequired(false))
            .addIntegerOption(o => o.setName('max-tickets').setDescription('Max open tickets per user (0 = unlimited)').setRequired(false).setMinValue(0).setMaxValue(10))
            .addChannelOption(o => o.setName('closed-category').setDescription('Move closed tickets to this category (omit to keep)').setRequired(false)
                .addChannelTypes(ChannelType.GuildCategory))
            .addBooleanOption(o => o.setName('delete-on-close').setDescription('Delete the channel when a ticket closes').setRequired(false)))
        .addSubcommand(sub => sub
            .setName('panel')
            .setDescription('Post the Components V2 ticket panel (admin).')
            .addChannelOption(o => o.setName('channel').setDescription('Target channel (defaults to this channel)').setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(sub => sub
            .setName('close')
            .setDescription('Close the ticket in the current channel.'))
        .addSubcommand(sub => sub
            .setName('claim')
            .setDescription('Claim the ticket in the current channel (staff).'))
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Give a user access to the current ticket (staff).')
            .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a user from the current ticket (staff).')
            .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('config')
            .setDescription('Show the effective ticket configuration (admin).'))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show ticket stats for this server.'))
        .addSubcommand(sub => sub
            .setName('transcript')
            .setDescription('Generate and upload an HTML transcript (staff).'))
        .addSubcommand(sub => sub
            .setName('rename')
            .setDescription('Rename the current ticket channel (staff).')
            .addStringOption(o => o.setName('name').setDescription('New channel name').setRequired(true).setMinLength(2).setMaxLength(90)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        const staffSubs = new Set(['close', 'claim', 'add', 'remove', 'status', 'transcript', 'rename']);

        // Ticket participation commands are usable by anyone inside a ticket;
        // admin/setup commands require Manage Server.
        if (!staffSubs.has(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need **Manage Server** permission to use this command.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Acknowledge immediately so the interaction can never time out
        // while config/DB/Discord lookups run.
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (error) {
            // 10062 Unknown interaction = the interaction token already expired
            // (gateway lag / double-click), not a code bug. Nothing can answer it.
            if (error?.code === 10062) {
                logger.warn(`/ticket ${sub} defer skipped: interaction already expired (10062).`);
            } else {
                logger.error(`/ticket ${sub} defer failed: ${error.stack || error}`);
            }
            return;
        }

        try {
            switch (sub) {
                case 'setup': return await setupTickets(interaction);
                case 'panel': return await postPanel(interaction);
                case 'close': return await closeCurrent(interaction);
                case 'claim': return await claimCurrent(interaction);
                case 'add': return await addMember(interaction);
                case 'remove': return await removeMember(interaction);
                case 'config': return await showConfig(interaction);
                case 'status': return await showStatus(interaction);
                case 'transcript': return await transcriptCurrent(interaction);
                case 'rename': return await renameCurrent(interaction);
                default: return await interaction.editReply('❌ Unknown ticket subcommand.');
            }
        } catch (error) {
            logger.error(`/ticket ${sub} failed: ${error.stack || error}`);
            // The interaction was already acknowledged above; every failure
            // path below is guarded so it is never left unanswered.
            try {
                await interaction.editReply(`❌ Failed: ${error.message}`);
            } catch {
                try {
                    await interaction.followUp({ content: `❌ Failed: ${error.message}`, flags: MessageFlags.Ephemeral });
                } catch {
                    // Response window closed — already logged above.
                }
            }
        }
    }
};

async function setupTickets(interaction) {
    if (!isDatabaseReady()) {
        await interaction.editReply('❌ The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
        return;
    }
    const panelChannel = interaction.options.getChannel('panel-channel');
    const logChannel = interaction.options.getChannel('log-channel');
    const logToggle = interaction.options.getBoolean('log-toggle');
    const maxTickets = interaction.options.getInteger('max-tickets');
    const closedCategory = interaction.options.getChannel('closed-category');
    const deleteOnClose = interaction.options.getBoolean('delete-on-close');

    const set = {};
    if (panelChannel) set['tickets.panelChannelId'] = panelChannel.id;
    if (logChannel) set['tickets.logChannelId'] = logChannel.id;
    if (logToggle !== null) set['tickets.logsEnabled'] = logToggle;
    if (maxTickets !== null) set['tickets.maxOpenTicketsPerUser'] = maxTickets;
    if (closedCategory) set['tickets.closedCategoryId'] = closedCategory.id;
    if (deleteOnClose !== null) set['tickets.deleteImmediately'] = deleteOnClose;

    if (Object.keys(set).length === 0) {
        await interaction.editReply('ℹ️ Nothing to update — provide at least one option, or use `/ticket config` to view the current configuration.\nAdvanced settings (categories, staff roles, naming) live in `config.yml` under `tickets:`.');
        return;
    }

    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: set });
    await interaction.editReply(`✅ Ticket settings updated (${Object.keys(set).length} value${Object.keys(set).length === 1 ? '' : 's'}). Use \`/ticket config\` to review.`);
}

async function postPanel(interaction) {
    const config = await resolveTicketsConfig(interaction.guild);
    if (!config.enabled) {
        await interaction.editReply('❌ The ticket system is disabled in configuration.');
        return;
    }
    const categories = Object.keys(config.categories || {});
    if (categories.length === 0) {
        await interaction.editReply('❌ No ticket categories are configured. Add some under `tickets.categories` in `config.yml`.');
        return;
    }

    const target = interaction.options.getChannel('channel')
        || (config.panel.channelId ? await interaction.guild.channels.fetch(config.panel.channelId).catch(() => null) : null)
        || interaction.channel;

    if (!target?.isTextBased() || !target.viewable) {
        await interaction.editReply('❌ The target channel is not available.');
        return;
    }

    await target.send(buildPanel(config));
    await interaction.editReply(`✅ Ticket panel posted in ${target} with ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`);
}

async function loadCurrentTicket(interaction) {
    const ticket = await ticketRepository.getTicketByChannel(interaction.guild.id, interaction.channelId);
    if (!ticket) {
        await interaction.editReply('❌ This command can only be used inside a ticket channel.');
        return null;
    }
    return ticket;
}

async function closeCurrent(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (ticket.status === 'closed' || ticket.status === 'deleted') {
        await interaction.editReply('❌ This ticket is already closed.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    if (!canCloseTicket({ member: interaction.member, ticket, config })) {
        await interaction.editReply('❌ You do not have permission to close this ticket.');
        return;
    }
    const result = await closeTicket({
        client: interaction.client,
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    await interaction.editReply(result.ok
        ? (result.deleted ? '✅ Ticket closed. The channel will be deleted shortly.' : '✅ Ticket closed and archived.')
        : result.error);
}

async function claimCurrent(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (!canClaimTicket({ member: interaction.member, ticket, guild: interaction.guild })) {
        await interaction.editReply('❌ You cannot claim this ticket.\nOnly ticket staff and administrators can claim tickets.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    const result = await claimTicket({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    await interaction.editReply(result.ok
        ? `✅ You claimed ticket \`#${ticket.number}\`.`
        : result.error);
}

async function addMember(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (ticket.status !== 'open' && ticket.status !== 'claimed') {
        await interaction.editReply('❌ This ticket is closed.');
        return;
    }
    if (!isStaffForTicket(interaction.member, ticket)) {
        await interaction.editReply('❌ Only staff members can add users to a ticket.');
        return;
    }
    const target = interaction.options.getUser('user');
    if (target.bot) {
        await interaction.editReply('❌ Bots cannot be added to tickets.');
        return;
    }
    const result = await setMemberAccess({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        targetUserId: target.id,
        grant: true
    });
    if (!result.ok) {
        await interaction.editReply(result.error);
        return;
    }
    const targetName = safePlainText(target.username, 100);
    const adderName = safePlainText(interaction.user.username, 100);
    await interaction.editReply(`✅ ${targetName} was added to this ticket.`);
    await logTicket(interaction.guild, {
        title: '➕ User Added to Ticket',
        accent: 0x5865F2,
        fields: [
            { label: 'Ticket', value: await resolveTicketChannelName(interaction.guild, ticket) },
            { label: 'Ticket ID', value: `#${ticket.number}` },
            { label: 'User', value: targetName },
            { label: 'User ID', value: String(target.id) },
            { label: 'Added By', value: adderName },
            { label: 'Added By ID', value: String(interaction.user.id) }
        ]
    });
}

async function removeMember(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (ticket.status !== 'open' && ticket.status !== 'claimed') {
        await interaction.editReply('❌ This ticket is closed.');
        return;
    }
    if (!isStaffForTicket(interaction.member, ticket)) {
        await interaction.editReply('❌ Only staff members can remove users from a ticket.');
        return;
    }
    const target = interaction.options.getUser('user');
    const result = await setMemberAccess({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        targetUserId: target.id,
        grant: false
    });
    if (!result.ok) {
        await interaction.editReply(result.error);
        return;
    }
    const targetName = safePlainText(target.username, 100);
    const removerName = safePlainText(interaction.user.username, 100);
    await interaction.editReply(`✅ ${targetName} was removed from this ticket.`);
    await logTicket(interaction.guild, {
        title: '➖ User Removed from Ticket',
        accent: 0xFEE75C,
        fields: [
            { label: 'Ticket', value: await resolveTicketChannelName(interaction.guild, ticket) },
            { label: 'Ticket ID', value: `#${ticket.number}` },
            { label: 'User', value: targetName },
            { label: 'User ID', value: String(target.id) },
            { label: 'Removed By', value: removerName },
            { label: 'Removed By ID', value: String(interaction.user.id) }
        ]
    });
}

async function transcriptCurrent(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (!isStaffForTicket(interaction.member, ticket)) {
        await interaction.editReply('❌ Only staff members can generate transcripts.');
        return;
    }
    const config = await resolveTicketsConfig(interaction.guild);
    await interaction.editReply('⏳ Generating transcript — fetching all messages...');
    const result = await sendTranscript({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        config
    });
    if (!result.ok) {
        await interaction.editReply(result.error);
        return;
    }
    // Deliver the file directly too, so staff get it even without log access.
    // files[] here is a REAL Discord attachment (native download/open UI).
    const directContent = `✅ Transcript saved: ${result.filename} (${result.count} messages). Also uploaded to the ticket-log channel.${result.attachmentUrl ? `\n${result.attachmentUrl}` : ''}`;
    try {
        await interaction.editReply({
            content: directContent,
            files: [{ attachment: result.buffer, name: result.filename }]
        });
    } catch {
        await interaction.editReply(directContent);
    }
}

async function renameCurrent(interaction) {
    const ticket = await loadCurrentTicket(interaction);
    if (!ticket) return;
    if (ticket.status !== 'open' && ticket.status !== 'claimed') {
        await interaction.editReply('❌ This ticket is closed.');
        return;
    }
    if (!isStaffForTicket(interaction.member, ticket)) {
        await interaction.editReply('❌ Only staff members can rename tickets.');
        return;
    }
    const name = interaction.options.getString('name');
    const result = await renameTicket({
        guild: interaction.guild,
        member: interaction.member,
        ticket,
        name
    });
    await interaction.editReply(result.ok
        ? `✅ Ticket renamed to #${result.name}.`
        : result.error);
}

async function resolveChannelDisplay(guild, channelId) {
    // Cache first, fetch fallback. IDs stay strings throughout.
    const id = String(channelId);
    let channel = guild.channels.cache.get(id) || null;
    if (!channel) channel = await guild.channels.fetch(id).catch(() => null);
    if (channel && typeof channel.isTextBased === 'function' && channel.isTextBased()) {
        return `<#${id}>`;
    }
    return `⚠️ Invalid/inaccessible (\`${id}\`)`;
}

async function resolveRoleDisplay(guild, roleId) {
    // Resolved by ID via cache/fetch only — never by name, never as a number.
    const id = String(roleId);
    let role = guild.roles.cache.get(id) || null;
    if (!role) role = await guild.roles.fetch(id).catch(() => null);
    if (role) return `<@&${id}>`;
    return `⚠️ Missing role (\`${id}\`)`;
}

async function resolveRoleListDisplay(guild, roleIds) {
    const ids = (roleIds || []).map((id) => String(id));
    if (ids.length === 0) return '_none_';
    const resolved = await Promise.all(ids.map((id) => resolveRoleDisplay(guild, id)));
    return resolved.join(', ');
}

async function showConfig(interaction) {
    const config = await resolveTicketsConfig(interaction.guild);
    const logChannel = config.logs.channelId
        ? await resolveChannelDisplay(interaction.guild, config.logs.channelId)
        : '_not set_';
    const panelChannel = config.panel.channelId
        ? await resolveChannelDisplay(interaction.guild, config.panel.channelId)
        : '_not set_';
    const supportRole = config.supportRoleId
        ? await resolveRoleDisplay(interaction.guild, config.supportRoleId)
        : '_not set_';
    const categories = [];
    for (const [key, c] of Object.entries(config.categories || {})) {
        categories.push({
            label: `Category: ${c.name} (\`${key}\`)`,
            value: `${c.description || '_no description_'}\nStaff: ${await resolveRoleListDisplay(interaction.guild, c.staffRoleIds)}`
        });
    }
    await interaction.editReply({
        ...buildInfoContainer({
            header: `🎫 Ticket Configuration — **${interaction.guild.name}**`,
            fields: [
                { label: 'System', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Panel channel', value: panelChannel },
                { label: 'Ticket logs', value: config.logs.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Log channel', value: logChannel },
                { label: 'Max open tickets per user', value: config.maxOpenTicketsPerUser === 0 ? 'Unlimited' : String(config.maxOpenTicketsPerUser) },
                { label: 'Support role (welcome ping)', value: supportRole },
                { label: 'Naming format', value: `\`${config.naming.format}\`` },
                { label: 'On close', value: config.close.deleteImmediately ? 'Delete channel' : `Archive${config.close.closedCategoryId ? ` → <#${config.close.closedCategoryId}>` : ''}` },
                ...categories
            ],
            accent: 0x5865F2,
            footer: 'Categories and staff roles are configured in config.yml under tickets:.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function showStatus(interaction) {
    const config = await resolveTicketsConfig(interaction.guild);
    const openCount = await ticketRepository.countOpenTickets(interaction.guild.id);
    const mine = await ticketRepository.getOpenTicketsByUser(interaction.guild.id, interaction.user.id);
    const categoryName = mine.length > 0 ? (getCategory(config, mine[0].category)?.name || mine[0].category) : null;
    await interaction.editReply({
        ...buildInfoContainer({
            header: '🎫 Ticket Status',
            fields: [
                { label: 'Open tickets (server)', value: String(openCount) },
                {
                    label: 'Your open ticket',
                    value: mine.length > 0 ? `<#${mine[0].channelId}> (${categoryName})` : '_none_'
                },
                { label: 'System', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' }
            ],
            accent: 0x5865F2
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
