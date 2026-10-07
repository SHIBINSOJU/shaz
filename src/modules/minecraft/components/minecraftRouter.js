const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { getMinecraftConfig, buildIpResponse, withIpResultLock, rememberEphemeralResult, clearEphemeralResult, editEphemeralResult } = require('../services/minecraftService');
const monitor = require('../services/statusMonitor');
const { buildStatusResponse, buildPlayersResponse } = require('../services/statusView');

// 10062 Unknown interaction = the 3s response window already closed (stale
// button click, gateway hiccup, or a lock-queued click that ran too late).
// 40060 = already acknowledged. Retrying an ack on these ALWAYS fails with a
// second 10062, so callers must downgrade to warn and stop instead.
function isInteractionExpired(error) {
    if (!error) return false;
    if (error.code === 10062 || error.code === 40060) return true;
    const msg = String(error.message || error);
    return /unknown interaction|already (been )?acknowledged|not repliable|cannot reply|expired/i.test(msg);
}

// Acknowledges an interaction exactly once. Safe to call when nothing has
// been acked yet; never throws. In DMs the plain reply is used because the
// channel itself is already private. Expired interactions are swallowed with
// a warn — a retry would only produce a second 10062.
async function ephemeralAck(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) return;
        if (typeof interaction.isRepliable === 'function' && !interaction.isRepliable()) {
            logger.warn(`Minecraft component ack skipped (${interaction.customId}): interaction no longer repliable (stale click).`);
            return;
        }
    } catch {
        return;
    }
    try {
        const inDM = isDmChannel(interaction);
        await interaction.reply(inDM ? { content } : { content, flags: MessageFlags.Ephemeral });
    } catch (firstError) {
        if (isInteractionExpired(firstError)) {
            logger.warn(`Minecraft component ack expired (${interaction.customId}): stale click, ignored — no retry attempted.`);
            return;
        }
        const inDM = isDmChannel(interaction);
        if (!inDM) {
            try {
                await interaction.reply({ content });
                return;
            } catch (retryError) {
                if (isInteractionExpired(retryError)) {
                    logger.warn(`Minecraft component ack expired on retry (${interaction.customId}): stale click, ignored.`);
                    return;
                }
            }
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

// True when a (possibly nested) component tree contains one of the given
// button customIds. Status buttons live INSIDE the Container, so the search
// must recurse — a flat top-level scan misses them.
function hasCustomId(component, ids) {
    if (!component) return false;
    if (ids.includes(component.customId)) return true;
    const kids = component.components || [];
    return Array.isArray(kids) && kids.some((kid) => hasCustomId(kid, ids));
}

// True when the interaction came from the status panel (permanent message or
// /mcstatus reply), identified by its buttons wherever they are nested.
function isStatusMessage(message) {
    try {
        return (message?.components || []).some((c) => hasCustomId(c, ['mc:status:refresh', 'mc:status:players']));
    } catch {
        return false;
    }
}

// The favicon PNG is attached as server-favicon.png and referenced by the
// thumbnail. Re-uploading it on EVERY refresh would pile attachments onto the
// permanent message, so edits reuse the existing attachment and only upload
// when the message does not have one yet.
function filesForEdit(message, payload) {
    const files = payload.files || [];
    if (files.length === 0) return [];
    try {
        const has = message?.attachments?.some?.((a) => a?.name === 'server-favicon.png');
        if (has) return [];
    } catch {}
    return files;
}

/**
 * Handles the 👥 Players button on the PUBLIC status Container. Replies with a
 * FRESH ephemeral Components V2 player list — the main status message is never
 * edited and the names never go public. Defers first so a cold-cache poll can
 * never blow the 3s ack window ("Interaction Failed" is impossible here: every
 * path either edits the deferred reply or falls back to an ephemeral ack).
 */
async function handlePlayersList(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
        let snapshot = monitor.getSnapshot();
        if (!snapshot.lastChecked) {
            snapshot = await monitor.poll('players-button');
        }
        const payload = buildPlayersResponse(snapshot);
        await interaction.editReply({
            components: payload.components,
            files: [],
            flags: payload.flags,
            allowedMentions: payload.allowedMentions
        });
    } catch (error) {
        if (isInteractionExpired(error)) {
            logger.warn(`Minecraft players list expired (${interaction.customId}): stale click, ignored — no retry attempted.`);
            return;
        }
        logger.error(`Minecraft players list failed (${interaction.customId}): ${error.stack || error}`);
        try {
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({ content: '❌ Could not load the player list right now. Please try again.', components: [], files: [] });
            } else {
                await ephemeralAck(interaction, '❌ Could not load the player list right now. Please try again.');
            }
        } catch {}
    }
}

/**
 * Handles the 🔄 Refresh button on the PUBLIC status Container (both the
 * permanent channel message and /mcstatus replies). Defers immediately (a real
 * poll can exceed the 3s ack window), refreshes through the RATE-LIMITED
 * monitor, and edits THE SAME message in place — never posts a new one.
 */
async function handleStatusRefresh(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }
        const { snapshot, throttled } = await monitor.refresh();
        const payload = buildStatusResponse(snapshot, { throttled });
        await interaction.editReply({
            components: payload.components,
            files: filesForEdit(interaction.message, payload),
            flags: payload.flags,
            allowedMentions: payload.allowedMentions
        });
    } catch (error) {
        if (isInteractionExpired(error)) {
            logger.warn(`Minecraft status refresh expired (${interaction.customId}): stale click, ignored — no retry attempted.`);
            return;
        }
        logger.error(`Minecraft status refresh failed (${interaction.customId}): ${error.stack || error}`);
        await ephemeralAck(interaction, '❌ Could not refresh the server status right now. Please try again.');
    }
}

module.exports = {
    customId: 'mc',

    async execute(interaction) {
        const parts = (interaction.customId || '').split(':');

        // customId formats: mc:status:refresh (public refresh) and
        // mc:status:players (private ephemeral player list). The mc:players
        // shorthand is a legacy alias for the same handler.
        if (parts[1] === 'status' || parts[1] === 'players') {
            if (parts[2] === 'players' || parts[1] === 'players') {
                await handlePlayersList(interaction);
                return;
            }
            await handleStatusRefresh(interaction);
            return;
        }

        // customId format: mc:ip:<edition>
        if (parts[1] !== 'ip') {
            // A stale/unknown button sitting ON the status panel still belongs
            // to the status handler: refresh it instead of misrouting to the
            // server-IP flow. Anything else keeps the original ack.
            if (isStatusMessage(interaction.message)) {
                await handleStatusRefresh(interaction);
                return;
            }
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
                    try {
                        if (interaction.deferred || interaction.replied) {
                            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 });
                        } else {
                            await interaction.update({ ...payload, flags: MessageFlags.IsComponentsV2 });
                        }
                    } catch (updateError) {
                        if (isInteractionExpired(updateError)) {
                            // Stale click (button older than the ~15m token
                            // lifetime, or a lock-queued click that ran past
                            // the 3s window): drop the dead result entry so the
                            // next click starts fresh. Never retry — it can
                            // only produce a second 10062.
                            clearEphemeralResult(interaction.user.id);
                            logger.warn(`Minecraft IP button expired before update (${interaction.customId}, user ${interaction.user.id}): stale click, ignored — no retry attempted.`);
                            return;
                        }
                        throw updateError;
                    }
                    rememberEphemeralResult(
                        interaction.user.id,
                        interaction.applicationId,
                        interaction.token,
                        interaction.message.id
                    );
                    return;
                }

                // The click came from a public legacy message. Ack FIRST so the
                // slow webhook edit below can never push us past the 3s window
                // (that ordering was the main source of 10062s here).
                try {
                    if (!interaction.deferred && !interaction.replied) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    }
                } catch (deferError) {
                    if (isInteractionExpired(deferError)) {
                        logger.warn(`Minecraft IP button expired before defer (${interaction.customId}, user ${interaction.user.id}): stale click, ignored — no retry attempted.`);
                        return;
                    }
                    throw deferError;
                }

                // Reuse the user's single private result when one exists, so
                // repeated clicks edit it instead of stacking new messages.
                // The current interaction is already deferred, so removing the
                // thinking state is enough — no new message is posted.
                const reused = await editEphemeralResult(interaction.user.id, payload.components);
                if (reused) {
                    try {
                        await interaction.deleteReply();
                    } catch {}
                    return;
                }

                // No reusable result: answer with a NEW ephemeral message via
                // the deferred reply — the address is never written onto a
                // channel message.
                try {
                    await interaction.editReply(payload);
                } catch (replyError) {
                    if (isInteractionExpired(replyError)) {
                        clearEphemeralResult(interaction.user.id);
                        logger.warn(`Minecraft IP button expired before reply (${interaction.customId}, user ${interaction.user.id}): stale click, ignored — no retry attempted.`);
                        return;
                    }
                    throw replyError;
                }
                const sent = await interaction.fetchReply().catch(() => null);
                rememberEphemeralResult(
                    interaction.user.id,
                    interaction.applicationId,
                    interaction.token,
                    sent?.id
                );
            });
        } catch (error) {
            if (isInteractionExpired(error)) {
                logger.warn(`Minecraft component handler expired (${interaction.customId}): stale click, ignored — no retry attempted.`);
                return;
            }
            logger.error(`Minecraft component handler failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeralAck(interaction, '❌ Could not show the server IP right now. Please try again.');
        }
    }
};
