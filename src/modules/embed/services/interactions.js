// Shared guards for builder button/select/modal interactions.

const { MessageFlags } = require('discord.js');
const { getSession } = require('./sessionStore');
const { buildDashboard, buildExpiredNotice } = require('./dashboard');

async function loadSession(interaction, sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        const payload = { content: '⏰ This embed builder has expired. Run `/embed` to start a new session.', flags: MessageFlags.Ephemeral };
        try {
            if (interaction.isModalSubmit() || interaction.deferred || interaction.replied) {
                await interaction.reply(payload).catch(() => interaction.followUp(payload).catch(() => {}));
            } else {
                await interaction.reply(payload);
            }
        } catch { /* response window closed */ }
        // Best effort: disable the stale dashboard controls.
        try {
            if (interaction.message) await interaction.message.edit(buildExpiredNotice());
        } catch { /* message deleted — nothing to do */ }
        return null;
    }
    if (interaction.user.id !== session.userId) {
        await interaction.reply({
            content: '❌ You cannot control this builder.',
            flags: MessageFlags.Ephemeral
        }).catch(() => {});
        return null;
    }
    return session;
}

async function refreshDashboard(interaction, session) {
    await interaction.update(buildDashboard(session, interaction.member));
}

async function notifyEphemeral(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch { /* response window closed */ }
}

module.exports = { loadSession, refreshDashboard, notifyEphemeral };
