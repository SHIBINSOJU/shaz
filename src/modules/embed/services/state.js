// Builder state: the single source of truth for both the live preview and
// the final sent message. Ordered `blocks` render top-to-bottom inside one
// Container. Reserved keys (templateId, scheduledFor, ...) are left for
// future template/scheduling expansion.

const crypto = require('crypto');

// Server brand emoji, used as the default footer and as the header/footer
// input placeholder across the /embed builder.
const RISE_EMOJI = '<:RISE:1489608533832896674>';

function newBlockId() {
    return `b${crypto.randomBytes(3).toString('hex')}`;
}

function createDefaultState() {
    return {
        accent: 0x5865F2,
        header: { enabled: true, text: '🎉 Welcome to our server!' },
        blocks: [],
        thumbnail: { enabled: false, url: '', description: '' },
        footer: { enabled: true, text: RISE_EMOJI }
    };
}

function createTextBlock(content = '') {
    return { id: newBlockId(), type: 'text', content };
}

function createSeparatorBlock() {
    return { id: newBlockId(), type: 'separator', divider: true, spacing: 'Small' };
}

function createMediaBlock() {
    return { id: newBlockId(), type: 'media', items: [] };
}

function createButtonsBlock() {
    return { id: newBlockId(), type: 'buttons', buttons: [] };
}

function getBlock(state, blockId) {
    return state.blocks.find((b) => b.id === blockId) || null;
}

function removeBlock(state, blockId) {
    const index = state.blocks.findIndex((b) => b.id === blockId);
    if (index === -1) return false;
    state.blocks.splice(index, 1);
    return true;
}

function moveBlock(state, blockId, direction) {
    const index = state.blocks.findIndex((b) => b.id === blockId);
    if (index === -1) return false;
    const target = index + direction;
    if (target < 0 || target >= state.blocks.length) return false;
    const [block] = state.blocks.splice(index, 1);
    state.blocks.splice(target, 0, block);
    return true;
}

function countByType(state, type) {
    return state.blocks.filter((b) => b.type === type).length;
}

function describeBlock(block, index) {
    const n = index + 1;
    switch (block.type) {
        case 'text': {
            const preview = (block.content || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)';
            return `#${n} Text — "${preview}"`;
        }
        case 'separator':
            return `#${n} Separator`;
        case 'media':
            return `#${n} Media (${block.items.length} item${block.items.length === 1 ? '' : 's'})`;
        case 'buttons':
            return `#${n} Buttons (${block.buttons.length} button${block.buttons.length === 1 ? '' : 's'})`;
        default:
            return `#${n} ${block.type}`;
    }
}

module.exports = {
    RISE_EMOJI,
    createDefaultState,
    createTextBlock,
    createSeparatorBlock,
    createMediaBlock,
    createButtonsBlock,
    getBlock,
    removeBlock,
    moveBlock,
    countByType,
    describeBlock
};
