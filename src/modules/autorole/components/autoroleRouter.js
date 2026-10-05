// Single router for all `autorole:*` component interactions.
// Registered as customId prefix `autorole` (see componentHandler prefix matching).
//
// Currently handles the /autorole clear confirmation. Sessions bind the
// confirmation to the initiating user and expire after 5 minutes, and the
// Administrator permission is re-checked on click.

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');

const CLEAR_TTL_MS = 5 * 60 * 1000;
const clearSessions = new Map();

function createClearSession(sessionId, userId, guildId) {
    sweepClearSessions();
    clearSessions.set(sessionId, { userId, guildId, createdAt: Date.now() });
}

function takeClearSession(sessionId) {
    sweepClearSessions();
    const session = clearSessions.get(sessionId) || null;
    if (session) clearSessions.delete(sessionId);
    return session;
}

function sweepClearSessions() {
    const now = Date.now();
    for (const [id, session] of clearSessions) {
        if (now - session.createdAt > CLEAR_TTL_MS) clearSessions.delete(id);
    }
}

module.exports = {
    customId: 'autorole',

    async execute(interaction) {
        try {
            const parts = (interaction.customId || '').split(':');
            if (parts[0] !== 'autorole' || parts.length < 4) return;

            const [, action, decision, sessionId] = parts;
            if (action !== 'clear' || (decision !== 'confirm' && decision !== 'cancel')) return;

            if (!interaction.inGuild()) {
                await interaction.reply({ content: '❌ This can only be used inside a server.', flags: MessageFlags.Ephemeral });
                return;
            }

            const session = takeClearSession(sessionId);
            if (!session || session.guildId !== interaction.guild.id) {
                await interaction.reply({ content: '⏰ This confirmation has expired. Run `/autorole clear` again if needed.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (interaction.user.id !== session.userId) {
                await interaction.reply({ content: '❌ Only the administrator who ran `/autorole clear` can confirm it.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: '❌ You need **Administrator** permission to manage Autorole.', flags: MessageFlags.Ephemeral });
                return;
            }

            if (decision === 'cancel') {
                await interaction.update({
                    ...buildInfoContainer({
                        header: 'Autorole clear cancelled',
                        fields: [{ label: 'Note', value: 'Configuration unchanged.' }],
                        accent: 0x5865F2
                    }),
                    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
                });
                return;
            }

            if (!isDatabaseReady()) {
                await interaction.update({
                    ...buildInfoContainer({
                        header: '❌ Cannot clear Autorole',
                        fields: [{ label: 'Reason', value: 'The database is not connected, so the configuration cannot be cleared.' }],
                        accent: 0xED4245
                    }),
                    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
                });
                return;
            }

            await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'autorole.roles': [] } });
            logger.info(`Autorole cleared for guild ${interaction.guild.id} by ${interaction.user.id}`);
            await interaction.update({
                ...buildInfoContainer({
                    header: '✅ Autorole configuration cleared',
                    fields: [{ label: 'Note', value: 'Existing members keep their roles.' }],
                    accent: 0x57F287
                }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            });
        } catch (error) {
            logger.error(`Autorole component failed (${interaction.customId}): ${error.stack || error}`);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.followUp({ content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
                }
            } catch {
                // Response window already closed.
            }
        }
    }
};

module.exports.createClearSession = createClearSession;
