const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const {
    getMinecraftConfig,
    buildIpResponse,
    isValidHostname,
    isValidPort,
    sanitizeHostname,
    setPersistentMinecraftConfig,
    loadPersistentMinecraftConfig
} = require('../services/minecraftService');
const monitor = require('../services/statusMonitor');

function hasManagePermission(interaction) {
    try {
        if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
        if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    } catch (e) {}
    return false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ip')
        .setDescription('Manage or view Minecraft Java and Bedrock connection details.')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View currently configured Java and Bedrock addresses')
        )
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Set Minecraft connection details (Java, Bedrock, or both)')
                .addStringOption(option =>
                    option.setName('target')
                        .setDescription('Which edition to set')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Java', value: 'java' },
                            { name: 'Bedrock', value: 'bedrock' },
                            { name: 'Both', value: 'both' }
                        )
                )
                .addStringOption(option =>
                    option.setName('java_host')
                        .setDescription('Java hostname/IP')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option.setName('java_port')
                        .setDescription('Java port')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('bedrock_host')
                        .setDescription('Bedrock hostname/IP')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('bedrock_port')
                        .setDescription('Bedrock UDP port')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('reset')
                .setDescription('Reset Minecraft connection details to configured defaults')
                .addStringOption(option =>
                    option.setName('confirm')
                        .setDescription('Type "confirm" to reset')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const config = getMinecraftConfig();

        if (sub === 'view') {
            const payload = buildIpResponse(config, 'all');
            await interaction.reply({ ...payload, flags: payload.flags });
            return;
        }

        if (sub === 'reset') {
            if (!hasManagePermission(interaction)) {
                await interaction.reply({ content: '❌ You do not have permission to modify IP settings.', ephemeral: true });
                return;
            }
            const confirm = interaction.options.getString('confirm');
            if (confirm !== 'confirm') {
                await interaction.reply({ content: '❌ Reset cancelled. Type `confirm` to proceed.', ephemeral: true });
                return;
            }
            try {
                await guildSettingsRepository.updateGlobalMinecraftSettings({
                    javaHost: null,
                    javaPort: null,
                    bedrockHost: null,
                    bedrockPort: null
                });
                setPersistentMinecraftConfig(null);
                await loadPersistentMinecraftConfig();
            } catch (e) {
                logger.error(`Failed to reset minecraft settings: ${e.message}`);
                await interaction.reply({ content: '❌ Failed to reset configuration.', ephemeral: true });
                return;
            }
            const newCfg = getMinecraftConfig();
            await interaction.reply({ content: '✅ Minecraft IP configuration reset to defaults.', ephemeral: true });
            try {
                if (monitor && typeof monitor.poll === 'function') {
                    await monitor.poll('ip-reset');
                }
                if (monitor && typeof monitor.publish === 'function') {
                    await monitor.publish();
                }
            } catch (e) {
                logger.error(`Failed to refresh status after IP reset: ${e.message}`);
            }
            return;
        }

        if (sub === 'set') {
            if (!hasManagePermission(interaction)) {
                await interaction.reply({ content: '❌ You do not have permission to modify IP settings.', ephemeral: true });
                return;
            }
            const target = interaction.options.getString('target');
            const javaHostOpt = interaction.options.getString('java_host');
            const javaPortOpt = interaction.options.getInteger('java_port');
            const bedrockHostOpt = interaction.options.getString('bedrock_host');
            const bedrockPortOpt = interaction.options.getString('bedrock_port');

            const update = {};

            if (target === 'java' || target === 'both') {
                if (!javaHostOpt) {
                    await interaction.reply({ content: '❌ Java hostname/IP is required when setting Java.', ephemeral: true });
                    return;
                }
                if (!isValidHostname(javaHostOpt)) {
                    await interaction.reply({ content: '❌ Invalid Java hostname/IP.', ephemeral: true });
                    return;
                }
                update.javaHost = sanitizeHostname(javaHostOpt);
                if (javaPortOpt !== null && javaPortOpt !== undefined) {
                    if (!isValidPort(javaPortOpt)) {
                        await interaction.reply({ content: '❌ Invalid Java port.', ephemeral: true });
                        return;
                    }
                    update.javaPort = parseInt(javaPortOpt);
                }
            }

            if (target === 'bedrock' || target === 'both') {
                if (!bedrockHostOpt) {
                    await interaction.reply({ content: '❌ Bedrock hostname/IP is required when setting Bedrock.', ephemeral: true });
                    return;
                }
                if (!isValidHostname(bedrockHostOpt)) {
                    await interaction.reply({ content: '❌ Invalid Bedrock hostname/IP.', ephemeral: true });
                    return;
                }
                update.bedrockHost = sanitizeHostname(bedrockHostOpt);
                if (bedrockPortOpt !== null && bedrockPortOpt !== undefined) {
                    if (!isValidPort(bedrockPortOpt)) {
                        await interaction.reply({ content: '❌ Invalid Bedrock port.', ephemeral: true });
                        return;
                    }
                    update.bedrockPort = parseInt(bedrockPortOpt);
                }
            }

            try {
                await guildSettingsRepository.updateGlobalMinecraftSettings(update);
                await loadPersistentMinecraftConfig();
            } catch (e) {
                logger.error(`Failed to save minecraft settings: ${e.message}`);
                await interaction.reply({ content: '❌ Failed to save configuration.', ephemeral: true });
                return;
            }

            const updated = getMinecraftConfig();
            await interaction.reply({ content: '✅ Minecraft IP configuration updated successfully.', ephemeral: true });
            try {
                if (monitor && typeof monitor.poll === 'function') {
                    await monitor.poll('ip-update');
                }
                if (monitor && typeof monitor.publish === 'function') {
                    await monitor.publish();
                }
            } catch (e) {
                logger.error(`Failed to refresh status after IP update: ${e.message}`);
            }
            return;
        }

        const payload = buildIpResponse(config, 'all');
        await interaction.reply({ ...payload, flags: payload.flags });
    }
};
