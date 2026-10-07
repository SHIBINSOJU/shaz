const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../../core/logger');
const monitor = require('../services/statusMonitor');
const { buildStatusResponse } = require('../services/statusView');

// PUBLIC live status for the ONE combined RISE SMP server. The reply is a
// Components V2 Container visible to everyone (no Ephemeral flag). The monitor
// also keeps the single permanent channel message in sync via poll->publish.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('mcstatus')
        .setDescription('Show the live status of the RISE SMP Minecraft server.'),

    async execute(interaction) {
        const cfg = monitor.getStatusConfig();
        if (!cfg.enabled) {
            await interaction.reply({ content: '❌ Minecraft status monitoring is disabled.' });
            return;
        }

        // A first-time poll can take up to the query timeout (>3s), so defer.
        // No Ephemeral flag: the status is PUBLIC by design.
        await interaction.deferReply();

        let snapshot = monitor.getSnapshot();
        if (!snapshot.lastChecked) {
            snapshot = await monitor.poll('command');
        }

        const payload = buildStatusResponse(snapshot);
        try {
            // flags (IsComponentsV2) come from the SAME shared builder the
            // automatic updater uses — required, or Discord rejects Containers.
            await interaction.editReply({
                components: payload.components,
                files: payload.files || [],
                flags: payload.flags,
                allowedMentions: payload.allowedMentions
            });
        } catch (error) {
            logger.error(`mcstatus reply failed: ${error.stack || error}`);
            // Honest error — never a compact one-liner pretending to be status.
            try {
                await interaction.editReply({ content: '❌ Could not load the Minecraft server status right now. Please try again in a moment.', components: [], files: [] });
            } catch {}
        }
    }
};
