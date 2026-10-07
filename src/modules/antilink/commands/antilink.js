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
        // Acknowledge EXACTLY ONCE and as early as possible. Everything else
        // (permission checks, DB, config) happens AFTER the ack, so a slow
        // database or cold start can never push us past Discord's ~3s window
        // (which surfaces as DiscordAPIError[10062]: Unknown interaction).
        const acked = await safeAcknowledge(interaction);
        if (!acked) {
            // Interaction already expired/invalid — do NOT attempt a second
            // response; that only produces another 10062. The failure is logged
            // inside safeAcknowledge.
            return;
        }

        try {
            if (!interaction.inGuild()) {
                await safeEdit(interaction, '❌ This command can only be used inside a server.');
                return;
            }

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                await safeEdit(interaction, '❌ You need **Manage Server** permission to manage Anti-Link.');
                return;
            }

            const group = interaction.options.getSubcommandGroup(false);
            const sub = interaction.options.getSubcommand();

            if (group === 'channel') {
                if (sub === 'enable') return await setChannelOverride(interaction, false);
                return await setChannelOverride(interaction, true);
            }
            switch (sub) {
                case 'enable': return await setGlobalToggle(interaction, true);
                case 'disable': return await setGlobalToggle(interaction, false);
                case 'status': return await showStatus(interaction);
                default: return await safeEdit(interaction, '❌ Unknown antilink subcommand.');
            }
        } catch (error) {
            logger.error(`/antilink failed: ${error.stack || error}`);
            await safeEdit(interaction, `❌ Failed to update Anti-Link: ${error.message}`);
        }
    }
};

function isUnknownInteraction(error) {
    if (!error) return false;
    if (error.code === 10062) return true;
    if (error.status === 404 && /unknown interaction/i.test(error.message || '')) return true;
    return false;
}

/**
 * Single safe acknowledgement for this command. Returns true when the
 * interaction is now deferred (caller may editReply), false when the
 * interaction is already dead (caller must NOT respond again).
 */
async function safeAcknowledge(interaction) {
    try {
        if (interaction.deferred || interaction.replied) return true;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return true;
    } catch (error) {
        if (isUnknownInteraction(error)) {
            logger.warn(`/antilink ack failed: interaction expired before deferReply (10062) — user likely re-clicked a stale command or the gateway hiccuped. No retry attempted.`);
            return false;
        }
        throw error;
    }
}

/** Edit the deferred reply; swallows 10062 instead of throwing a second error. */
async function safeEdit(interaction, contentOrPayload) {
    const payload = typeof contentOrPayload === 'string' ? contentOrPayload : contentOrPayload;
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        } else {
            // Should not happen (we always defer first), but never double-ack:
            // reply once if somehow not yet acknowledged.
            await interaction.reply(typeof payload === 'string'
                ? { content: payload, flags: MessageFlags.Ephemeral }
                : payload);
        }
    } catch (error) {
        if (isUnknownInteraction(error)) {
            logger.warn(`/antilink response dropped: interaction expired (10062).`);
            return;
        }
        throw error;
    }
}

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

async function setGlobalToggle(interaction, enabled) {
    requireDatabase();
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'antilink.enabled': enabled } });
    await safeEdit(interaction, enabled
        ? '✅ **Anti-Link enabled** — links will be blocked in all channels except configured exceptions.'
        : '✅ **Anti-Link disabled** — links are allowed everywhere in this server.');
}

async function setChannelOverride(interaction, disabled) {
    requireDatabase();
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!channel?.id) {
        await safeEdit(interaction, '❌ Could not determine the target channel.');
        return;
    }
    if (disabled) {
        await guildSettingsRepository.updateGuildSettings(
            interaction.guild.id,
            { $addToSet: { 'antilink.disabledChannels': channel.id } }
        );
        await safeEdit(interaction, `✅ Anti-Link **disabled** in ${channel} — links are allowed there.`);
    } else {
        await guildSettingsRepository.updateGuildSettings(
            interaction.guild.id,
            { $pull: { 'antilink.disabledChannels': channel.id } }
        );
        await safeEdit(interaction, `✅ Anti-Link **enabled** in ${channel} — links will be blocked there.`);
    }
}

async function showStatus(interaction) {
    const config = await resolveAntiLinkConfig(interaction.guild);
    const disabled = config.disabledChannels || [];

    await safeEdit(interaction, {
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
