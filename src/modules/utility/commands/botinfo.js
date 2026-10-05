const { SlashCommandBuilder, MessageFlags, version: djsVersion } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { isDatabaseReady } = require('../../../database/connection');
const { fail, formatDuration } = require('../services/helpers');
const { version: botVersion } = require('../../../../package.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription('Show information about the bot.'),

    async execute(interaction, ctx) {
        await interaction.deferReply();
        try {
            const client = interaction.client;
            const guilds = client.guilds.cache;
            let users = 0;
            for (const guild of guilds.values()) users += guild.memberCount ?? 0;
            const uptimeMs = client.uptime ?? process.uptime() * 1000;

            await interaction.editReply({
                ...buildInfoContainer({
                    header: `🤖 ${client.user?.tag ?? 'Shaz'}`,
                    fields: [
                        { label: 'Bot name', value: client.user?.tag ?? 'Unknown' },
                        { label: 'Bot version', value: `v${botVersion}` },
                        { label: 'Discord.js version', value: `v${djsVersion}` },
                        { label: 'Node.js version', value: process.version },
                        { label: 'Servers', value: `${guilds.size}` },
                        { label: 'Users', value: `~${users}` },
                        { label: 'Commands', value: `${ctx?.moduleManager?.commands?.size ?? '?'}` },
                        { label: 'Modules', value: `${ctx?.moduleManager?.modules?.size ?? '?'}` },
                        { label: 'Uptime', value: formatDuration(uptimeMs) },
                        { label: 'Database', value: isDatabaseReady() ? '🟢 Connected' : '🔴 Disconnected' },
                        { label: 'Bot latency', value: client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'Unavailable' }
                    ],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/botinfo', error);
        }
    }
};
