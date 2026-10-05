const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType
} = require('discord.js');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { resolveAntiLinkConfig } = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('antilink')
        .setDescription('Manage the server-wide Anti-Link system.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('enable')
            .setDescription('Enable Anti-Link for this server (all channels by default).'))
        .addSubcommand(sub => sub
            .setName('disable')
            .setDescription('Disable Anti-Link for this server.'))
        .addSubcommandGroup(group => group
            .setName('channel')
            .setDescription('Override Anti-Link for a specific channel.')
            .addSubcommand(sub => sub
                .setName('enable')
                .setDescription('Enforce Anti-Link in a channel (removes its exception).')
                .addChannelOption(o => o.setName('channel')
                    .setDescription('Target channel (defaults to the current channel)')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
            .addSubcommand(sub => sub
                .setName('disable')
                .setDescription('Allow links in a channel (adds an exception).')
                .addChannelOption(o => o.setName('channel')
                    .setDescription('Target channel (defaults to the current channel)')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show the current Anti-Link configuration.')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need **Manage Server** permission to manage Anti-Link.', flags: MessageFlags.Ephemeral });
            return;
        }

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (group === 'channel') {
                if (sub === 'enable') return await setChannelOverride(interaction, false);
                return await setChannelOverride(interaction, true);
            }
            switch (sub) {
                case 'enable': return await setGlobalToggle(interaction, true);
                case 'disable': return await setGlobalToggle(interaction, false);
                case 'status': return await showStatus(interaction);
                default: return await interaction.editReply('❌ Unknown antilink subcommand.');
            }
        } catch (error) {
            logger.error(`/antilink ${group ? `${group} ` : ''}${sub} failed: ${error.stack || error}`);
            await interaction.editReply(`❌ Failed to update Anti-Link: ${error.message}`);
        }
    }
};

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

async function setGlobalToggle(interaction, enabled) {
    requireDatabase();
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'antilink.enabled': enabled } });
    await interaction.editReply(enabled
        ? '✅ **Anti-Link enabled** — links will be blocked in all channels except configured exceptions.'
        : '✅ **Anti-Link disabled** — links are allowed everywhere in this server.');
}

async function setChannelOverride(interaction, disabled) {
    requireDatabase();
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!channel?.id) {
        await interaction.editReply('❌ Could not determine the target channel.');
        return;
    }
    if (disabled) {
        await guildSettingsRepository.updateGuildSettings(
            interaction.guild.id,
            { $addToSet: { 'antilink.disabledChannels': channel.id } }
        );
        await interaction.editReply(`✅ Anti-Link **disabled** in ${channel} — links are allowed there.`);
    } else {
        await guildSettingsRepository.updateGuildSettings(
            interaction.guild.id,
            { $pull: { 'antilink.disabledChannels': channel.id } }
        );
        await interaction.editReply(`✅ Anti-Link **enabled** in ${channel} — links will be blocked there.`);
    }
}

async function showStatus(interaction) {
    const config = await resolveAntiLinkConfig(interaction.guild);
    const disabled = config.disabledChannels || [];

    await interaction.editReply({
        ...buildInfoContainer({
            header: '🛡️ Anti-Link',
            fields: [
                { label: 'Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Default', value: 'All Channels' },
                {
                    label: 'Disabled Channels',
                    value: disabled.length > 0
                        ? disabled.map((id) => `<#${id}>`).join(', ')
                        : '_none_'
                }
            ],
            accent: 0x5865F2,
            footer: 'Use /antilink channel disable #channel to add an exception.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
