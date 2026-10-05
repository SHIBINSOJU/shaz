const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { getMinecraftConfig, buildIpResponse } = require('../services/minecraftService');

// Acknowledges an interaction exactly once with a plain ephemeral message.
// Safe to call when nothing has been acked yet; never throws.
async function ephemeralAck(interaction, content) {
    if (interaction.deferred || interaction.replied) return;
    try {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        logger.error(`Minecraft component ack failed (${interaction.customId}): ${error.stack || error}`);
    }
}

// True when the button lives on a message only its viewer can see.
function isPrivateSource(message) {
    return Boolean(message?.flags?.has(MessageFlags.Ephemeral));
}

module.exports = {
    customId: 'mc',

    async execute(interaction) {
        const parts = (interaction.customId || '').split(':');
        // customId format: mc:ip:<edition>
        if (parts[1] !== 'ip') {
            // Unknown mc:* action — still ack so Discord never shows "Interaction failed".
            await ephemeralAck(interaction, '❌ That button is no longer available. Run `/serverip` again.');
            return;
        }

        try {
            const edition = parts[2] || 'all';
            const config = getMinecraftConfig();
            const payload = buildIpResponse(config, edition);

            if (interaction.isButton() && isPrivateSource(interaction.message)) {
                // The source message is already ephemeral: swap the view in place.
                // (Updating keeps it private for the viewer.)
                await interaction.update({ ...payload, flags: MessageFlags.IsComponentsV2 });
            } else {
                // The source is the public IP-free prompt (or a legacy message):
                // answer with a NEW ephemeral message, so the address is never
                // written onto a channel message.
                await interaction.reply(payload);
            }
        } catch (error) {
            logger.error(`Minecraft component handler failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeralAck(interaction, '❌ Could not show the server IP right now. Please try again.');
        }
    }
};
