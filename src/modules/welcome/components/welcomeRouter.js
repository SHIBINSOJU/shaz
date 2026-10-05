// Single router for every `welcome:*` button, the channel select menu and the
// message modal. Registered as customId prefix `welcome` (componentHandler
// prefix matching), so the panel is self-contained.
//
// This router only CONTROLs the existing welcome system: every read goes through
// services/settings.js (config.yml → GuildSettings.welcome → draft) and every
// preview goes through the production WelcomeBuilder. No second renderer, no
// second configuration store.
//
// ACKNOWLEDGEMENT ARCHITECTURE (exactly once per interaction):
// - Panel refreshes defer with DeferredMessageUpdate FIRST (DB reads and the
//   welcome-card GIF composition can be slow), then finish with one editReply.
// - "Edit Message" answers with showModal() only — never also a reply.
// - The modal submit edits the panel message it was launched from.
// - respond() never acks twice: update → editReply → followUp → give up when the
//   token is expired (10062), which is the only case Discord can no longer take.

const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');
const logger = require('../../../core/logger');
const { isDatabaseReady } = require('../../../database/connection');
const { withRetry } = require('../../../utils/retry');
const {
    MESSAGE_MIN,
    MESSAGE_MAX,
    validateWelcomeMessage,
    validateWelcomeToggle,
    saveWelcomeSettings
} = require('../services/settings');
const { getSession, destroySession } = require('../services/welcomePanelStore');
const {
    panelState,
    resolvePanelChannel,
    renderMainPanel,
    renderChannelPanel,
    renderTogglePanel,
    renderPreviewPanel
} = require('../services/welcomePanelSession');
const { TOGGLES, buildNotice, buildCancelled, buildExpired } = require('../services/welcomePanel');

const TOGGLE_FIELDS = ['enabled', 'thumbnailEnabled', 'separatorEnabled', 'cardEnabled', 'welcomeBots'];
const DENY = '❌ You don\'t have permission to configure the welcome system.';

// Plain ephemeral text, used before/around the rich panel payloads. Never
// double-acks: replies if untouched, follows up if already acknowledged.
async function ephemeral(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch { /* response window closed */ }
}

// Finish an interaction with a Components V2 panel, exactly once.
async function respond(interaction, payload) {
    try {
        if (interaction.deferred) return await interaction.editReply(payload);
        return await interaction.update(payload);
    } catch (error) {
        if (error?.code === 10062) return; // token expired — nothing can answer it
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp(payload);
            } else {
                await interaction.reply(payload);
            }
        } catch { /* response window closed */ }
    }
}

async function deferPanel(interaction) {
    try {
        await interaction.deferUpdate();
        return true;
    } catch (error) {
        if (error?.code === 10062) {
            logger.warn('Welcome panel update skipped: interaction already expired (10062).');
        } else {
            logger.error(`Welcome panel defer failed: ${error.stack || error}`);
        }
        return false;
    }
}

async function errorView(interaction, sessionId, { header, lines }) {
    await respond(interaction, buildNotice({ sessionId, header, lines, tone: 'error' }));
}

// The slash command is gated by Manage Server; components re-check it, because
// an old panel message can outlive a permission change.
async function canConfigure(interaction) {
    if (interaction.guild?.ownerId === interaction.user.id) return true;
    let permissions = interaction.memberPermissions;
    if (!permissions && interaction.guildId) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        permissions = member?.permissions ?? null;
    }
    return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild));
}

// Resolve the session and validate owner + guild + permission. Returns null
// (having already answered) when the interaction may not continue.
async function authorize(interaction, sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        await respond(interaction, buildExpired());
        return null;
    }
    if (!interaction.inGuild()) {
        await ephemeral(interaction, '❌ Welcome settings can only be managed inside a server.');
        return null;
    }
    if (String(session.guildId) !== String(interaction.guild.id)) {
        await ephemeral(interaction, DENY);
        return null;
    }
    if (session.userId !== interaction.user.id) {
        await ephemeral(interaction, '❌ Only the administrator who opened this panel can control it.');
        return null;
    }
    if (!await canConfigure(interaction)) {
        await ephemeral(interaction, DENY);
        return null;
    }
    return session;
}

async function refreshMain(interaction, session, { notice } = {}) {
    await respond(interaction, await renderMainPanel(session, interaction.guild, { notice }));
}

module.exports = {
    customId: 'welcome',

    async execute(interaction) {
        const parts = (interaction.customId || '').split(':');
        if (parts[0] !== 'welcome' || parts.length < 3) return;

        const action = parts[1];
        const sessionId = parts[2];

        try {
            const session = await authorize(interaction, sessionId);
            if (!session) return;

            switch (action) {
                case 'message':
                    return await openMessageForm(interaction, session);
                case 'channel':
                    if (!await deferPanel(interaction)) return;
                    return await respond(interaction, await renderChannelPanel(session, interaction.guild));
                case 'field': {
                    const field = parts[3];
                    if (!TOGGLES[field]) {
                        return await ephemeral(interaction, '❌ Unknown welcome setting.');
                    }
                    if (!await deferPanel(interaction)) return;
                    return await respond(interaction, await renderTogglePanel(session, interaction.guild, field));
                }
                case 'set':
                    return await applyToggle(interaction, session, parts[3], parts[4]);
                case 'chansel':
                    return await applyChannelSelect(interaction, session);
                case 'preview':
                    return await showPreview(interaction, session);
                case 'save':
                    return await savePanel(interaction, session);
                case 'back':
                    if (!await deferPanel(interaction)) return;
                    return await refreshMain(interaction, session);
                case 'cancel':
                    if (!await deferPanel(interaction)) return;
                    destroySession(sessionId);
                    return await respond(interaction, buildCancelled(session.openedBy));
                default:
                    return await ephemeral(interaction, '❌ That welcome control is no longer available. Run `/welcome` again.');
            }
        } catch (error) {
            logger.error(`Welcome component failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeral(interaction, '❌ Something went wrong. Please try again.');
        }
    },

    async handleModal(interaction) {
        const parts = (interaction.customId || '').split(':');
        // welcome:modal:<form>:<sessionId>
        if (parts[1] !== 'modal' || parts.length < 4) return;
        const sessionId = parts[3];

        try {
            const session = await authorize(interaction, sessionId);
            if (!session) return;

            if (parts[2] !== 'message') {
                return await ephemeral(interaction, '❌ Unknown welcome form.');
            }

            const raw = field(interaction, 'message');
            if (!raw.trim()) {
                // Modal inputs are required, but a whitespace-only submit is still
                // possible — keep the draft untouched instead of corrupting it.
                return await errorView(interaction, sessionId, {
                    header: '❌ Message not updated',
                    lines: ['The welcome message cannot be empty.']
                });
            }

            const validated = validateWelcomeMessage(raw);
            if (!validated.ok) {
                return await errorView(interaction, sessionId, {
                    header: '❌ Message not updated',
                    lines: [`⚠️ ${validated.error}`]
                });
            }

            session.draft.message = validated.value;
            return await refreshMain(interaction, session, {
                notice: '📝 Message updated — press 💾 Save to apply it.'
            });
        } catch (error) {
            logger.error(`Welcome modal failed (${interaction.customId}): ${error.stack || error}`);
            await ephemeral(interaction, '❌ Something went wrong saving that change. Your draft is unchanged.');
        }
    }
};

async function openMessageForm(interaction, session) {
    // showModal() IS the acknowledgement, so nothing may be deferred first.
    const { config } = await panelState(interaction.guild, session.draft);

    const input = new TextInputBuilder()
        .setCustomId('message')
        .setLabel('Welcome message')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(MESSAGE_MIN)
        .setMaxLength(MESSAGE_MAX)
        .setPlaceholder('Welcome {user} to {server}!');
    if (config.message) input.setValue(config.message.slice(0, MESSAGE_MAX));

    const modal = new ModalBuilder()
        .setCustomId(`welcome:modal:message:${session.id}`)
        .setTitle('📝 Edit Welcome Message')
        .addComponents(new ActionRowBuilder().addComponents(input));

    try {
        await interaction.showModal(modal);
    } catch (error) {
        if (error?.code !== 40060 && error?.code !== 10062) {
            logger.error(`Welcome modal could not open: ${error.stack || error}`);
        }
        await ephemeral(interaction, '❌ Could not open the message editor. Please try again.');
    }
}

async function applyToggle(interaction, session, field, decision) {
    if (!TOGGLE_FIELDS.includes(field)) {
        return await ephemeral(interaction, '❌ Unknown welcome setting.');
    }
    const validated = validateWelcomeToggle(field, decision === 'on');
    if (!validated.ok) {
        return await ephemeral(interaction, `❌ ${validated.error}`);
    }

    session.draft[field] = validated.value;
    if (!await deferPanel(interaction)) return;
    const meta = TOGGLES[field];
    return await refreshMain(interaction, session, {
        notice: `${meta.emoji} ${meta.label} set to ${validated.value ? '🟢 Enabled' : '🔴 Disabled'} — press 💾 Save to apply it.`
    });
}

async function applyChannelSelect(interaction, session) {
    if (!interaction.isChannelSelectMenu()) {
        return await ephemeral(interaction, '❌ That control is not a channel selector.');
    }
    if (!await deferPanel(interaction)) return;

    const channelId = interaction.values?.[0];
    const channel = await resolvePanelChannel(interaction.guild, channelId);
    if (!channel) {
        return await refreshMain(interaction, session, {
            notice: '⚠️ That channel is not available to me. Selection discarded.'
        });
    }

    session.draft.channelId = channel.id;
    return await refreshMain(interaction, session, {
        notice: `📺 Welcome channel: #${channel.name} — press 💾 Save to apply it.`
    });
}

async function showPreview(interaction, session) {
    if (!await deferPanel(interaction)) return;

    // The admin stands in for the joining member: nothing about real member data
    // is touched, but the render path is identical to the guildMemberAdd event.
    const member = await withRetry(() => interaction.guild.members.fetch(interaction.user.id), { attempts: 2 })
        .catch(() => interaction.member);

    try {
        await respond(interaction, await renderPreviewPanel(session, interaction.guild, member));
    } catch (error) {
        logger.error(`Welcome preview failed: ${error.stack || error}`);
        await respond(interaction, buildNotice({
            sessionId: session.id,
            header: '❌ Preview unavailable',
            lines: [`⚠️ ${safeReason(error)}`],
            tone: 'error'
        }));
    }
}

async function savePanel(interaction, session) {
    if (!await deferPanel(interaction)) return;
    const draft = { ...session.draft };

    if (!isDatabaseReady()) {
        return await respond(interaction, buildNotice({
            sessionId: session.id,
            header: '❌ Failed to save welcome settings.',
            lines: ['⚠️ The database is not connected, so per-server settings cannot be saved.'],
            tone: 'error'
        }));
    }

    // ---- validate everything before touching the stored configuration ----
    if (draft.message !== undefined) {
        const validated = validateWelcomeMessage(draft.message);
        if (!validated.ok) {
            return await errorView(interaction, session.id, {
                header: '❌ Failed to save welcome settings.',
                lines: [`⚠️ ${validated.error}`]
            });
        }
        draft.message = validated.value;
    }

    for (const field of TOGGLE_FIELDS) {
        if (draft[field] === undefined) continue;
        const validated = validateWelcomeToggle(field, draft[field]);
        if (!validated.ok) {
            return await errorView(interaction, session.id, {
                header: '❌ Failed to save welcome settings.',
                lines: [`⚠️ ${validated.error}`]
            });
        }
    }

    if (draft.channelId) {
        const channel = await resolvePanelChannel(interaction.guild, draft.channelId);
        if (!channel) {
            return await errorView(interaction, session.id, {
                header: '❌ Failed to save welcome settings.',
                lines: ['⚠️ That welcome channel no longer exists or I cannot see it. Choose it again with 📺 Set Channel.']
            });
        }
    }

    try {
        const changed = await saveWelcomeSettings(interaction.guild.id, draft);
        logger.info(`Welcome settings updated for guild ${interaction.guild.id} by ${interaction.user.id} (${changed} field(s))`);
        // Persisted: drop the draft so the panel shows the stored values again.
        session.draft = {};

        const { channel } = await panelState(interaction.guild, null);
        const notice = channel
            ? '✅ Welcome settings updated successfully.'
            : '✅ Welcome settings updated successfully.\n⚠️ Channel not configured — welcome messages fall back to the system channel.';
        return await refreshMain(interaction, session, { notice });
    } catch (error) {
        logger.error(`Welcome save failed: ${error.stack || error}`);
        return await errorView(interaction, session.id, {
            header: '❌ Failed to save welcome settings.',
            lines: [`⚠️ ${safeReason(error)}`]
        });
    }
}

// Discord error messages can be long; keep the UI readable without hiding the cause.
function safeReason(error) {
    const message = String(error?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').trim();
    return message.slice(0, 180);
}

function field(interaction, name) {
    try {
        return interaction.fields.getTextInputValue(name) || '';
    } catch {
        return '';
    }
}
