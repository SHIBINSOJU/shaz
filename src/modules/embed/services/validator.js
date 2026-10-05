// Pre-send validation of the component tree: nesting, counts, text lengths,
// URLs, and Discord Components V2 limits. Never throws — returns { ok, errors }.

const { hasContent } = require('./renderer');

function isHttpUrl(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 2000) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function validateState(state, limits) {
    const errors = [];

    if (!hasContent(state)) {
        errors.push('The message is empty — add a header, text, media, buttons, or footer first.');
        return { ok: false, errors };
    }

    const maxText = limits.maxTextLength;

    if (state.header.enabled && state.header.text.length > maxText) {
        errors.push(`Header is too long (${state.header.text.length}/${maxText} characters).`);
    }
    if (state.footer.enabled && state.footer.text.length > maxText) {
        errors.push(`Footer is too long (${state.footer.text.length}/${maxText} characters).`);
    }

    const texts = state.blocks.filter((b) => b.type === 'text');
    const separators = state.blocks.filter((b) => b.type === 'separator');
    const mediaBlocks = state.blocks.filter((b) => b.type === 'media');
    const buttonRows = state.blocks.filter((b) => b.type === 'buttons');

    if (texts.length > limits.maxTextBlocks) errors.push(`Too many text sections (${texts.length}/${limits.maxTextBlocks}). Remove one.`);
    if (separators.length > limits.maxSeparators) errors.push(`Too many separators (${separators.length}/${limits.maxSeparators}). Remove one.`);
    if (mediaBlocks.length > limits.maxMediaBlocks) errors.push(`Too many media galleries (${mediaBlocks.length}/${limits.maxMediaBlocks}). Remove one.`);
    if (buttonRows.length > limits.maxButtonRows) errors.push(`Too many button rows (${buttonRows.length}/${limits.maxButtonRows}). Remove one.`);

    for (const [i, block] of texts.entries()) {
        if ((block.content || '').length > maxText) {
            errors.push(`Text section #${i + 1} is too long (${block.content.length}/${maxText} characters).`);
        }
    }

    for (const [i, block] of mediaBlocks.entries()) {
        if (block.items.length === 0) errors.push(`Media gallery #${i + 1} has no items — add an image URL or remove it.`);
        if (block.items.length > limits.maxMediaItemsPerBlock) {
            errors.push(`Media gallery #${i + 1} has too many items (${block.items.length}/${limits.maxMediaItemsPerBlock}).`);
        }
        for (const item of block.items) {
            if (!isHttpUrl(item.url)) errors.push(`Media gallery #${i + 1} has an invalid image URL. Use a full http(s) URL.`);
            if (item.description && item.description.length > 1024) {
                errors.push(`Media gallery #${i + 1} alt text is too long (max 1024 characters).`);
            }
        }
    }

    for (const [i, block] of buttonRows.entries()) {
        if (block.buttons.length === 0) errors.push(`Button row #${i + 1} has no buttons — add a button or remove it.`);
        if (block.buttons.length > limits.maxButtonsPerRow) {
            errors.push(`Button row #${i + 1} has too many buttons (${block.buttons.length}/${limits.maxButtonsPerRow}).`);
        }
        for (const btn of block.buttons) {
            if (!btn.label || !btn.label.trim()) errors.push(`Button row #${i + 1} has a button with no label.`);
            else if (btn.label.length > 80) errors.push(`Button "${btn.label.slice(0, 30)}…" label is too long (max 80 characters).`);
            if (!isHttpUrl(btn.url)) errors.push(`Button "${(btn.label || 'unlabeled').slice(0, 30)}" has an invalid URL. Use a full http(s) URL.`);
        }
    }

    if (state.thumbnail.enabled) {
        if (!isHttpUrl(state.thumbnail.url)) {
            errors.push('Thumbnail URL is invalid. Use a full http(s) image URL or clear it to disable the thumbnail.');
        }
        const sectionOk = (state.header.enabled && state.header.text.trim())
            || texts.some((b) => (b.content || '').trim());
        if (!sectionOk) errors.push('Thumbnail needs header or text content to attach to — add one first.');
    }

    if (state.accent !== null && state.accent !== undefined
        && (!Number.isInteger(state.accent) || state.accent < 0 || state.accent > 0xFFFFFF)) {
        errors.push('Accent color is invalid. Use a hex color like #5865F2.');
    }

    // Rendered container children must stay within the Discord limit.
    const children = (state.header.enabled && state.header.text.trim() ? 1 : 0)
        + state.blocks.length
        + (state.footer.enabled && state.footer.text.trim() ? 2 : 0);
    if (children > limits.maxContainerChildren) {
        errors.push(`Too many components (${children}/${limits.maxContainerChildren}). Remove or combine some blocks.`);
    }

    return { ok: errors.length === 0, errors };
}

// Would adding `addCount` more top-level blocks overflow the container?
function wouldOverflow(state, addCount, limits) {
    const children = (state.header.enabled && state.header.text.trim() ? 1 : 0)
        + state.blocks.length + addCount
        + (state.footer.enabled && state.footer.text.trim() ? 2 : 0);
    return children > limits.maxContainerChildren;
}

module.exports = { validateState, wouldOverflow, isHttpUrl };
