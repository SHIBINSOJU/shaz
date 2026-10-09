// Single router for all `embed:*` buttons and the block-picker select.
// Registered as customId prefix `embed` (see componentHandler prefix matching).

const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder
} = require('discord.js');
const logger = require('../../../core/logger');
const { getEmbedBuilderConfig } = require('../config');
const {
    createDefaultState,
    createSeparatorBlock,
    countByType,
    getBlock,
    removeBlock,
    moveBlock
} = require('../services/state');
const { validateState, wouldOverflow } = require('../services/validator');
const { buildMessage } = require('../services/renderer');
const { buildCancelledNotice } = require('../services/dashboard');
const { destroySession } = require('../services/sessionStore');
const { loadSession, refreshDashboard, notifyEphemeral } = require('../services/interactions');

function textInput(customId, label, { style = TextInputStyle.Short, required = false, maxLength = 4000, value = '', placeholder = '' } = {}) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(maxLength);
    if (value) input.setValue(value.slice(0, maxLength));
    if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
    return input;
}

function showModal(interaction, modalCustomId, title, inputs) {
    const modal = new ModalBuilder().setCustomId(modalCustomId).setTitle(title.slice(0, 45));
    for (const input of inputs) {
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return interaction.showModal(modal);
}

function accentToHex(accent) {
    if (accent === null || accent === undefined) return '';
    return `#${accent.toString(16).padStart(6, '0').toUpperCase()}`;
}

module.exports = {
    customId: 'embed',

    async execute(interaction) {
        try {
            const parts = (interaction.customId || '').split(':');
            if (parts[0] !== 'embed' || parts.length < 3) return;

            // Block-picker select: embed:pick:<sessionId>
            if (parts[1] === 'pick') {
                await handlePick(interaction, parts[2]);
                return;
            }

            const action = parts[1];
            const sessionId = parts[2];
            const session = await loadSession(interaction, sessionId);
            if (!session) return;

            switch (action) {
                case 'header':
                    await showModal(interaction, `embed:modal:header:${session.id}`,
                        'Edit Header', [
                        textInput('text', 'Header text (empty = disable)', {
                            required: false, maxLength: 1000,
                            value: session.state.header.enabled ? session.state.header.text : '',
                            placeholder: '<:RISE:1489608533832896674> '
                        })
                    ]);
                    break;
                case 'addtext':
                    if (!canAddText(session)) {
                        await notifyEphemeral(interaction, '❌ Text section limit reached, or the message is full. Remove a block first.');
                        break;
                    }
                    await showModal(interaction, `embed:modal:text:${session.id}`,
                        'Add Text Section', [
                        textInput('content', 'Text content', {
                            style: TextInputStyle.Paragraph, required: true, maxLength: 4000,
                            placeholder: 'Write announcements, rules, info…  Supports {server} {user} {membercount}'
                        })
                    ]);
                    break;
                case 'media':
                    if (!canAddMedia(session)) {
                        await notifyEphemeral(interaction, '❌ Media limit reached, or the message is full. Remove a block first.');
                        break;
                    }
                    await showModal(interaction, `embed:modal:media:${session.id}`,
                        'Add Media', [
                        textInput('url', 'Image / GIF URL', { required: true, maxLength: 2000, placeholder: 'https://example.com/image.png' }),
                        textInput('alt', 'Alt text (optional)', { required: false, maxLength: 1000 })
                    ]);
                    break;
                case 'buttons':
                    if (!canAddButton(session)) {
                        await notifyEphemeral(interaction, '❌ Button limit reached, or the message is full. Remove a block first.');
                        break;
                    }
                    await showModal(interaction, `embed:modal:button:${session.id}`,
                        'Add Link Button', [
                        textInput('label', 'Button label', { required: true, maxLength: 80, placeholder: '🌐 Website' }),
                        textInput('url', 'Button URL', { required: true, maxLength: 2000, placeholder: 'https://example.com' }),
                        textInput('emoji', 'Emoji (optional)', { required: false, maxLength: 100, placeholder: '🌐' })
                    ]);
                    break;
                case 'style':
                    await showModal(interaction, `embed:modal:style:${session.id}`,
                        'Message Style', [
                        textInput('color', 'Accent color hex (empty = default)', {
                            required: false, maxLength: 7,
                            value: accentToHex(session.state.accent),
                            placeholder: '#5865F2'
                        })
                    ]);
                    break;
                case 'thumbnail':
                    await showModal(interaction, `embed:modal:thumbnail:${session.id}`,
                        'Thumbnail', [
                        textInput('url', 'Thumbnail URL (empty = disable)', {
                            required: false, maxLength: 2000,
                            value: session.state.thumbnail.enabled ? session.state.thumbnail.url : ''
                        }),
                        textInput('alt', 'Alt text (optional)', {
                            required: false, maxLength: 1000,
                            value: session.state.thumbnail.description || ''
                        })
                    ]);
                    break;
                case 'separator':
                    if (!canAddBlock(session)) {
                        await notifyEphemeral(interaction, '❌ The message is full. Remove a block first.');
                        break;
                    }
                    session.state.blocks.push(createSeparatorBlock());
                    session.pendingAction = null;
                    await refreshDashboard(interaction, session);
                    break;
                case 'footer':
                    await showModal(interaction, `embed:modal:footer:${session.id}`,
                        'Edit Footer', [
                        textInput('text', 'Footer text (empty = disable)', {
                            required: false, maxLength: 1000,
                            value: session.state.footer.enabled ? session.state.footer.text : '',
                            placeholder: '<:RISE:1489608533832896674>'
                        })
                    ]);
                    break;
                case 'edit':
                case 'remove':
                case 'up':
                case 'down':
                    if (session.state.blocks.length === 0) {
                        await notifyEphemeral(interaction, '❌ There are no blocks to manage yet. Add text, media, or buttons first.');
                        break;
                    }
                    session.pendingAction = action;
                    await refreshDashboard(interaction, session);
                    break;
                case 'send':
                    await handleSend(interaction, session);
                    break;
                case 'reset':
                    session.state = createDefaultState();
                    session.pendingAction = null;
                    await refreshDashboard(interaction, session);
                    break;
                case 'cancel': {
                    const sid = session.id;
                    destroySession(sid);
                    await interaction.update(buildCancelledNotice());
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            logger.error(`Embed builder button failed (${interaction.customId}): ${error.stack || error}`);
            await notifyEphemeral(interaction, '❌ Something went wrong handling that button. Your draft is unchanged.');
        }
    }
};

function limits() {
    return getEmbedBuilderConfig().limits;
}

function canAddBlock(session) {
    return !wouldOverflow(session.state, 1, limits());
}

function canAddText(session) {
    return countByType(session.state, 'text') < limits().maxTextBlocks && canAddBlock(session);
}

function canAddMedia(session) {
    const blocks = session.state.blocks.filter((b) => b.type === 'media');
    const hasSpace = blocks.some((b) => b.items.length < limits().maxMediaItemsPerBlock);
    if (hasSpace) return true;
    return blocks.length < limits().maxMediaBlocks && canAddBlock(session);
}

function canAddButton(session) {
    const rows = session.state.blocks.filter((b) => b.type === 'buttons');
    const hasSpace = rows.some((b) => b.buttons.length < limits().maxButtonsPerRow);
    if (hasSpace) return true;
    return rows.length < limits().maxButtonRows && canAddBlock(session);
}

async function handlePick(interaction, sessionId) {
    const session = await loadSession(interaction, sessionId);
    if (!session) return;

    const blockId = interaction.values?.[0];
    const action = session.pendingAction;
    const block = blockId ? getBlock(session.state, blockId) : null;

    if (!action || !block) {
        session.pendingAction = null;
        await refreshDashboard(interaction, session);
        return;
    }

    try {
        if (action === 'edit') {
            await handleEditPick(interaction, session, block);
            return; // handleEditPick replies (modal) or notifies; dashboard stays as-is unless noted
        }
        if (action === 'remove') {
            removeBlock(session.state, block.id);
            session.pendingAction = null;
            await refreshDashboard(interaction, session);
            return;
        }
        if (action === 'up' || action === 'down') {
            const moved = moveBlock(session.state, block.id, action === 'up' ? -1 : 1);
            session.pendingAction = null;
            await refreshDashboard(interaction, session);
            if (!moved) {
                await notifyEphemeral(interaction, '❌ That block cannot move further in that direction.');
            }
            return;
        }
        session.pendingAction = null;
        await refreshDashboard(interaction, session);
    } catch (error) {
        logger.error(`Embed builder pick failed: ${error.stack || error}`);
        await notifyEphemeral(interaction, '❌ Something went wrong. Your draft is unchanged.');
    }
}

async function handleEditPick(interaction, session, block) {
    if (block.type === 'text') {
        await showModal(interaction, `embed:modal:text:${session.id}:${block.id}`,
            'Edit Text Section', [
            textInput('content', 'Text content (empty = remove block)', {
                style: TextInputStyle.Paragraph, required: false, maxLength: 4000,
                value: block.content || ''
            })
        ]);
        return;
    }
    if (block.type === 'media') {
        await showModal(interaction, `embed:modal:media:${session.id}:${block.id}`,
            'Add Media Item', [
            textInput('url', 'Image / GIF URL', { required: true, maxLength: 2000, placeholder: 'https://example.com/image.png' }),
            textInput('alt', 'Alt text (optional)', { required: false, maxLength: 1000 })
        ]);
        return;
    }
    if (block.type === 'buttons') {
        await showModal(interaction, `embed:modal:button:${session.id}:${block.id}`,
            'Add Link Button', [
            textInput('label', 'Button label', { required: true, maxLength: 80 }),
            textInput('url', 'Button URL', { required: true, maxLength: 2000 }),
            textInput('emoji', 'Emoji (optional)', { required: false, maxLength: 100 })
        ]);
        return;
    }
    await notifyEphemeral(interaction, 'ℹ️ Separators have no settings — use Up / Down / Remove to manage them.');
}

async function handleSend(interaction, session) {
    const { ok, errors } = validateState(session.state, limits());
    if (!ok) {
        await notifyEphemeral(interaction, `❌ Cannot send yet:\n• ${errors.join('\n• ')}`);
        return;
    }

    const guild = interaction.guild;
    const channel = guild
        ? await guild.channels.fetch(session.channelId).catch(() => null)
        : null;
    if (!channel || !channel.isTextBased() || !channel.viewable) {
        await notifyEphemeral(interaction, '❌ The target channel is no longer available. Your draft is kept — run `/embed` again to target a new channel.');
        return;
    }

    try {
        const payload = buildMessage(session.state, interaction.member);
        await channel.send(payload);
        await notifyEphemeral(interaction, `✅ Message sent to ${channel}. Your builder is still open if you want to tweak and resend.`);
    } catch (error) {
        logger.error(`Embed builder send failed: ${error.message}`);
        await notifyEphemeral(interaction, `❌ Could not send the message: ${error.message}\nYour draft is unchanged — fix the issue and try again.`);
    }
}
