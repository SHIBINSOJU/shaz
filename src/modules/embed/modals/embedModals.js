// Modal submit handler for all builder forms (`embed:modal:*`).
// Registered as customId prefix `embed:modal` (prefix matching in componentHandler).

const logger = require('../../../core/logger');
const { getEmbedBuilderConfig } = require('../config');
const {
    createTextBlock,
    createMediaBlock,
    createButtonsBlock,
    getBlock,
    removeBlock,
    countByType
} = require('../services/state');
const { isHttpUrl, wouldOverflow } = require('../services/validator');
const { loadSession, refreshDashboard, notifyEphemeral } = require('../services/interactions');

function field(interaction, name) {
    try {
        return (interaction.fields.getTextInputValue(name) || '').trim();
    } catch {
        return '';
    }
}

function parseAccent(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { ok: true, value: 0x5865F2 }; // empty = default
    const match = trimmed.match(/^#?([0-9a-f]{6})$/i);
    if (!match) return { ok: false };
    return { ok: true, value: parseInt(match[1], 16) };
}

module.exports = {
    customId: 'embed:modal',

    async handleModal(interaction) {
        try {
            const parts = (interaction.customId || '').split(':');
            // embed:modal:<form>:<sessionId>[:blockId]
            if (parts.length < 4) return;
            const form = parts[2];
            const sessionId = parts[3];
            const blockId = parts[4] || null;

            const session = await loadSession(interaction, sessionId);
            if (!session) return;

            switch (form) {
                case 'header': {
                    const text = field(interaction, 'text');
                    session.state.header.text = text;
                    session.state.header.enabled = text.length > 0;
                    break;
                }
                case 'text': {
                    const content = field(interaction, 'content');
                    if (blockId) {
                        const block = getBlock(session.state, blockId);
                        if (!block || block.type !== 'text') {
                            await notifyEphemeral(interaction, '❌ That text block no longer exists.');
                            return;
                        }
                        if (!content) {
                            removeBlock(session.state, block.id); // emptied = remove
                        } else {
                            block.content = content;
                        }
                    } else {
                        if (!content) {
                            await notifyEphemeral(interaction, '❌ Text content cannot be empty.');
                            return;
                        }
                        if (!canAddTextBlock(session.state)) {
                            await notifyEphemeral(interaction, '❌ Text section limit reached, or the message is full.');
                            return;
                        }
                        session.state.blocks.push({ ...createTextBlock(), content });
                    }
                    break;
                }
                case 'media': {
                    const url = field(interaction, 'url');
                    const alt = field(interaction, 'alt');
                    if (!isHttpUrl(url)) {
                        await notifyEphemeral(interaction, '❌ That media URL is invalid. Use a full http(s) URL (e.g. https://example.com/image.png).');
                        return;
                    }
                    const target = targetMediaBlock(session.state, blockId);
                    if (!target) {
                        await notifyEphemeral(interaction, '❌ Media limit reached, or the message is full. Remove a block first.');
                        return;
                    }
                    target.items.push({ url, description: alt });
                    break;
                }
                case 'button': {
                    const label = field(interaction, 'label');
                    const url = field(interaction, 'url');
                    const emoji = field(interaction, 'emoji');
                    if (!label) {
                        await notifyEphemeral(interaction, '❌ Button label cannot be empty.');
                        return;
                    }
                    if (label.length > 80) {
                        await notifyEphemeral(interaction, '❌ Button label is too long (max 80 characters).');
                        return;
                    }
                    if (!isHttpUrl(url)) {
                        await notifyEphemeral(interaction, '❌ That button URL is invalid. Use a full http(s) URL.');
                        return;
                    }
                    const target = targetButtonsBlock(session.state, blockId);
                    if (!target) {
                        await notifyEphemeral(interaction, '❌ Button limit reached, or the message is full. Remove a block first.');
                        return;
                    }
                    target.buttons.push({ label, url, emoji });
                    break;
                }
                case 'thumbnail': {
                    const url = field(interaction, 'url');
                    const alt = field(interaction, 'alt');
                    if (!url) {
                        session.state.thumbnail.enabled = false;
                        session.state.thumbnail.url = '';
                        session.state.thumbnail.description = '';
                        break;
                    }
                    if (!isHttpUrl(url)) {
                        await notifyEphemeral(interaction, '❌ That thumbnail URL is invalid. Use a full http(s) image URL.');
                        return;
                    }
                    session.state.thumbnail.enabled = true;
                    session.state.thumbnail.url = url;
                    session.state.thumbnail.description = alt;
                    break;
                }
                case 'footer': {
                    const text = field(interaction, 'text');
                    session.state.footer.text = text;
                    session.state.footer.enabled = text.length > 0;
                    break;
                }
                case 'style': {
                    const parsed = parseAccent(field(interaction, 'color'));
                    if (!parsed.ok) {
                        await notifyEphemeral(interaction, '❌ Invalid color. Use a hex color like #5865F2 (or leave empty for default).');
                        return;
                    }
                    session.state.accent = parsed.value;
                    break;
                }
                default:
                    await notifyEphemeral(interaction, '❌ Unknown builder form.');
                    return;
            }

            session.pendingAction = null;
            await refreshDashboard(interaction, session);
        } catch (error) {
            logger.error(`Embed builder modal failed (${interaction.customId}): ${error.stack || error}`);
            await notifyEphemeral(interaction, '❌ Something went wrong saving that change. Your draft is unchanged.');
        }
    }
};

function limits() {
    return getEmbedBuilderConfig().limits;
}

function canAddTextBlock(state) {
    return state.blocks.filter((b) => b.type === 'text').length < limits().maxTextBlocks
        && !wouldOverflow(state, 1, limits());
}

function targetMediaBlock(state, blockId) {
    const lim = limits();
    if (blockId) {
        const block = getBlock(state, blockId);
        if (block && block.type === 'media' && block.items.length < lim.maxMediaItemsPerBlock) return block;
        return null;
    }
    const existing = state.blocks.find((b) => b.type === 'media' && b.items.length < lim.maxMediaItemsPerBlock);
    if (existing) return existing;
    if (countByType(state, 'media') >= lim.maxMediaBlocks) return null;
    if (wouldOverflow(state, 1, lim)) return null;
    const block = createMediaBlock();
    state.blocks.push(block);
    return block;
}

function targetButtonsBlock(state, blockId) {
    const lim = limits();
    if (blockId) {
        const block = getBlock(state, blockId);
        if (block && block.type === 'buttons' && block.buttons.length < lim.maxButtonsPerRow) return block;
        return null;
    }
    const existing = state.blocks.find((b) => b.type === 'buttons' && b.buttons.length < lim.maxButtonsPerRow);
    if (existing) return existing;
    if (countByType(state, 'buttons') >= lim.maxButtonRows) return null;
    if (wouldOverflow(state, 1, lim)) return null;
    const block = createButtonsBlock();
    state.blocks.push(block);
    return block;
}
