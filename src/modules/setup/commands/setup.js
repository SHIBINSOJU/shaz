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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the bot for this server (welcome system, moderation logs, and more).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('welcome-channel')
            .setDescription('Set (or clear) the welcome message channel.')
            .addChannelOption(o => o.setName('channel').setDescription('Target channel (omit to reset to default)').setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(sub => sub
            .setName('welcome-toggle')
            .setDescription('Enable or disable the welcome system for this server.')
            .addBooleanOption(o => o.setName('enabled').setDescription('True to enable, false to disable').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('welcome-bots')
            .setDescription('Choose whether bots also get a welcome message.')
            .addBooleanOption(o => o.setName('allow').setDescription('True to welcome bots, false to skip them').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('modlog-channel')
            .setDescription('Set (or clear) the moderation log channel.')
            .addChannelOption(o => o.setName('channel').setDescription('Target channel (omit to reset to default)').setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(sub => sub
            .setName('modlog-toggle')
            .setDescription('Enable or disable moderation logging for this server.')
            .addBooleanOption(o => o.setName('enabled').setDescription('True to enable, false to disable').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('view')
            .setDescription('View the current effective configuration for this server.')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need **Manage Server** permission to configure the bot.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!isDatabaseReady()) {
            await interaction.reply({
                content: '❌ The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            switch (sub) {
                case 'welcome-channel': return await setWelcomeChannel(interaction);
                case 'welcome-toggle': return await setWelcomeToggle(interaction);
                case 'welcome-bots': return await setWelcomeBots(interaction);
                case 'modlog-channel': return await setModLogChannel(interaction);
                case 'modlog-toggle': return await setModLogToggle(interaction);
                case 'view': return await viewConfig(interaction);
                default: return await interaction.editReply('❌ Unknown setup subcommand.');
            }
        } catch (error) {
            logger.error(`/setup ${sub} failed: ${error.stack || error}`);
            await interaction.editReply(`❌ Failed to update configuration: ${error.message}`);
        }
    }
};

async function setWelcomeChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    const value = channel ? channel.id : null;
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'welcome.channelId': value } });
    await interaction.editReply(channel
        ? `✅ Welcome messages will now be sent to ${channel}.`
        : '✅ Welcome channel override cleared — falling back to the config default / system channel.');
}

async function setWelcomeToggle(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true);
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'welcome.enabled': enabled } });
    await interaction.editReply(`✅ Welcome system **${enabled ? 'enabled' : 'disabled'}** for this server.`);
}

async function setWelcomeBots(interaction) {
    const allow = interaction.options.getBoolean('allow', true);
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'welcome.welcomeBots': allow } });
    await interaction.editReply(`✅ Bots will **${allow ? 'now' : 'no longer'}** receive a welcome message.`);
}

async function setModLogChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    const value = channel ? channel.id : null;
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'moderation.logChannelId': value } });
    await interaction.editReply(channel
        ? `✅ Moderation logs will now be sent to ${channel}.`
        : '✅ Moderation log channel override cleared — falling back to the config default.');
}

async function setModLogToggle(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true);
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'moderation.logsEnabled': enabled } });
    await interaction.editReply(`✅ Moderation logging **${enabled ? 'enabled' : 'disabled'}** for this server.`);
}

async function viewConfig(interaction) {
    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(interaction.guild.id);
    } catch {
        db = null;
    }

    const welcomeChannelId = db?.welcome?.channelId || configService.get('welcome.channelId', '') || interaction.guild.systemChannelId || null;
    const welcomeEnabled = db?.welcome?.enabled ?? configService.get('welcome.enabled', true);
    const welcomeBots = db?.welcome?.welcomeBots ?? configService.get('welcome.welcomeBots', false);
    const modLogChannelId = db?.moderation?.logChannelId || configService.get('moderation.logs.channelId', '') || null;
    const modLogEnabled = (db?.moderation?.logsEnabled ?? true) && configService.get('moderation.logs.enabled', true);

    await interaction.editReply({
        ...buildInfoContainer({
            header: `⚙️ Configuration for **${interaction.guild.name}**`,
            fields: [
                { label: 'Welcome', value: welcomeEnabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Welcome channel', value: welcomeChannelId ? `<#${welcomeChannelId}>` : '_not set_' },
                { label: 'Welcome bots', value: welcomeBots ? 'Yes' : 'No' },
                { label: 'Moderation logs', value: modLogEnabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Mod log channel', value: modLogChannelId ? `<#${modLogChannelId}>` : '_not set_' }
            ],
            accent: 0x5865F2,
            footer: 'Values shown are per-server overrides on top of the global config.yml defaults.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
