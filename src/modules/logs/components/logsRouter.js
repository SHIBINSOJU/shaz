// Router for every `logs:*` control on the /logs setup panel.
// Registered as customId prefix `logs` (componentHandler prefix matching).
// Exactly-once acknowledgement: deferUpdate first, then a single editReply.
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const crypto = require('crypto');
const logger = require('../../../core/logger');
const { isDatabaseReady } = require('../../../database/connection');
const { renderPanel, buildClosed, buildExpired } = require('../services/logsPanel');
const { getCategoryConfig, setCategoryChannel, setCategoryEnabled } = require('../services/logConfig');
const { sendLog } = require('../services/logDispatcher');
const { CATEGORIES } = require('../config');
const { BRAND_RED } = require('../../../utils/brandColor');

const sessions = new Map(); // sid -> { id, userId, guildId, selected, expiresAt }
const SESSION_TTL_MS = 10 * 60 * 1000;

function createSession(userId, guildId) {
    const id = crypto.randomBytes(6).toString('hex');
    const session = { id, userId: String(userId), guildId: String(guildId), selected: 'member', expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(id, session);
    setTimeout(() => sessions.delete(id), SESSION_TTL_MS).unref?.();
    return session;
}

function getSession(sid) {
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
        sessions.delete(sid);
        return null;
    }
    return s;
}

async function canConfigure(interaction) {
    if (interaction.guild?.ownerId === interaction.user.id) return true;
    let permissions = interaction.memberPermissions;
    if (!permissions && interaction.guildId) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        permissions = member?.permissions ?? null;
    }
    return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild));
}

async function ephemeral(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch { /* response window closed */ }
}

async function respond(interaction, payload) {
    try {
        if (interaction.deferred) return await interaction.editReply(payload);
        return await interaction.update(payload);
    } catch (error) {
        if (error?.code === 10062) return;
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            }
        } catch { /* response window closed */ }
    }
}

async function refresh(interaction, session, notice = null) {
    await respond(interaction, await renderPanel(session, interaction.guild, notice));
}

module.exports = {
    customId: 'logs',
    createSession,
    getSession,

    async execute(interaction) {
        const parts = (interaction.customId || '').split(':');
        if (parts[0] !== 'logs' || parts.length < 3) return;
        const action = parts[1];
        const sessionId = parts[2];

        try {
            const session = getSession(sessionId);
            if (!session) {
                try {
                    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => null);
                    await respond(interaction, buildExpired());
                } catch { /* ignore */ }
                return;
            }
            if (!interaction.inGuild() || String(session.guildId) !== String(interaction.guild?.id)) {
                return await ephemeral(interaction, '❌ This panel belongs to a different server.');
            }
            if (session.userId !== interaction.user.id) {
                return await ephemeral(interaction, '❌ Only the administrator who opened this panel can control it.');
            }
            if (!await canConfigure(interaction)) {
                return await ephemeral(interaction, '❌ You need **Manage Server** permission to configure logging.');
            }

            switch (action) {
                case 'cat': {
                    if (!interaction.isStringSelectMenu()) return await ephemeral(interaction, '❌ That control is not a category selector.');
                    const value = interaction.values?.[0];
                    if (!CATEGORIES[value]) return await ephemeral(interaction, '❌ Unknown log category.');
                    session.selected = value;
                    await interaction.deferUpdate().catch(() => null);
                    return await refresh(interaction, session);
                }
                case 'chan': {
                    if (!interaction.isChannelSelectMenu()) return await ephemeral(interaction, '❌ That control is not a channel selector.');
                    if (!isDatabaseReady()) {
                        await interaction.deferUpdate().catch(() => null);
                        return await refresh(interaction, session, '⚠️ Database not connected — settings cannot be saved.');
                    }
                    const channelId = interaction.values?.[0];
                    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
                    if (!channel || !channel.isTextBased?.()) {
                        await interaction.deferUpdate().catch(() => null);
                        return await refresh(interaction, session, '⚠️ That channel is not available. Selection discarded.');
                    }
                    await interaction.deferUpdate().catch(() => null);
                    await setCategoryChannel(interaction.guild.id, session.selected, channel.id);
                    logger.info(`Log channel updated: guild ${interaction.guild.id} category ${session.selected} -> #${channel.name} by ${interaction.user.id}`);
                    return await refresh(interaction, session, `✅ ${CATEGORIES[session.selected].label} will now be sent to ${channel}.`);
                }
                case 'toggle': {
                    await interaction.deferUpdate().catch(() => null);
                    if (!isDatabaseReady()) {
                        return await refresh(interaction, session, '⚠️ Database not connected — settings cannot be saved.');
                    }
                    const current = await getCategoryConfig(interaction.guild.id, session.selected);
                    await setCategoryEnabled(interaction.guild.id, session.selected, !current.enabled);
                    return await refresh(interaction, session, `${!current.enabled ? '🟢' : '🔴'} ${CATEGORIES[session.selected].label} **${!current.enabled ? 'enabled' : 'disabled'}**.`);
                }
                case 'test': {
                    await interaction.deferUpdate().catch(() => null);
                    const ok = await sendLog(interaction.guild, session.selected, {
                        emoji: '📨',
                        title: `Test Log — ${CATEGORIES[session.selected].label}`,
                        accent: BRAND_RED,
                        thumbnailUrl: interaction.guild.iconURL?.({ size: 128 }) || null,
                        fields: [
                            { label: 'Category', value: CATEGORIES[session.selected].label },
                            { label: 'Requested by', value: `${interaction.user} (\`${interaction.user.id}\`)` },
                            { label: 'Note', value: 'If you can read this, the destination channel and permissions are correct.' }
                        ],
                        footer: `Server ID: ${interaction.guild.id}`
                    });
                    return await refresh(interaction, session, ok
                        ? `✅ Test log sent to ${CATEGORIES[session.selected].label}.`
                        : '⚠️ Test log could not be delivered — set a channel and check my **View Channel** / **Send Messages** permissions.');
                }
                case 'close': {
                    await interaction.deferUpdate().catch(() => null);
                    sessions.delete(sessionId);
                    return await respond(interaction, buildClosed());
                }
                default:
                    return await ephemeral(interaction, '❌ That log control is no longer available. Run `/logs setup` again.');
            }
        } catch (error) {
            logger.error(`Logs component failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeral(interaction, '❌ Something went wrong. Please try again.');
        }
    }
};
