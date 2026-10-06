const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { getMinecraftConfig, buildIpResponse, withIpResultLock, rememberEphemeralResult, editEphemeralResult } = require('../services/minecraftService');

// Acknowledges an interaction exactly once. Safe to call when nothing has
// been acked yet; never throws. In DMs the plain reply is used because the
// channel itself is already private.
async function ephemeralAck(interaction, content) {
    if (interaction.deferred || interaction.replied) return;
    const inDM = isDmChannel(interaction);
    try {
        await interaction.reply(inDM ? { content } : { content, flags: MessageFlags.Ephemeral });
    } catch (firstError) {
        if (!inDM) {
            try {
                await interaction.reply({ content });
                return;
            } catch {}
        }
        logger.error(`Minecraft component ack failed (${interaction.customId}): ${firstError.stack || firstError}`);
    }
}

// True when the button lives on a message only its viewer can see.
function isPrivateSource(message) {
    return Boolean(message?.flags?.has(MessageFlags.Ephemeral));
}

// True when the interaction happened in a DM — private by nature, so no
// ephemeral flag is needed (or accepted) there.
function isDmChannel(interaction) {
    try {
        return Boolean(interaction.channel?.isDMBased?.());
    } catch {
        return false;
    }
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
            // Serialized per user: concurrent clicks can't each slip past the
            // "no result yet" check and post stacked ephemeral messages.
            await withIpResultLock(interaction.user.id, async () => {
                const edition = parts[2] || 'all';
                const config = getMinecraftConfig();
                const payload = buildIpResponse(config, edition);

                const inDM = isDmChannel(interaction);

                if (interaction.isButton() && (isPrivateSource(interaction.message) || inDM)) {
                    // The click came from the user's own private result (their
                    // ephemeral reply or their DM panel): swap the view in
                    // place and keep the result editable through this fresh
                    // interaction token. No ephemeral flag needed — the message
                    // is already private.
                    await interaction.update({ ...payload, flags: MessageFlags.IsComponentsV2 });
                    rememberEphemeralResult(
                        interaction.user.id,
                        interaction.applicationId,
                        interaction.token,
                        interaction.message.id
                    );
                    return;
                }

                // The click came from a public legacy message: reuse the user's
                // single private result when one exists, so repeated clicks
                // edit it instead of stacking new messages. Otherwise answer
                // with a NEW ephemeral message — the address is never written
                // onto a channel message.
                const reused = await editEphemeralResult(interaction.user.id, payload.components);
                if (reused) return;

                await interaction.reply(payload);
                const sent = await interaction.fetchReply().catch(() => null);
                rememberEphemeralResult(
                    interaction.user.id,
                    interaction.applicationId,
                    interaction.token,
                    sent?.id
                );
            });
        } catch (error) {
            logger.error(`Minecraft component handler failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeralAck(interaction, '❌ Could not show the server IP right now. Please try again.');
        }
    }
};
