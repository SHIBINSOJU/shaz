// The ONE renderer for builder output. Both the dashboard live preview and
// the final 📤 Send path call buildMessage(state, member) — the preview can
// never drift from the actual message. Placeholders ({server}, {user}, ...)
// reuse the existing placeholder utility.

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { fillPlaceholders } = require('../../../utils/placeholders');

function applyPlaceholders(text, member) {
    if (!member) return text;
    try {
        return fillPlaceholders(text, member);
    } catch {
        return text;
    }
}

// A thumbnail needs a Section (text + accessory). It attaches to the header
// text, or to the first text block (which is then consumed from normal flow).
function resolveSectionTexts(state, member) {
    const headerText = state.header.enabled && state.header.text.trim()
        ? applyPlaceholders(state.header.text, member)
        : null;
    const firstTextIndex = state.blocks.findIndex(
        (b) => b.type === 'text' && (b.content || '').trim()
    );
    const firstText = firstTextIndex !== -1
        ? applyPlaceholders(state.blocks[firstTextIndex].content, member)
        : null;
    return { headerText, firstTextIndex, firstText };
}

function buildMessage(state, member = null) {
    const container = new ContainerBuilder();
    if (state.accent !== null && state.accent !== undefined) {
        container.setAccentColor(state.accent);
    }

    const { headerText, firstTextIndex, firstText } = resolveSectionTexts(state, member);
    const thumbnailOn = state.thumbnail.enabled && state.thumbnail.url.trim();
    const sectionTexts = [headerText, thumbnailOn ? firstText : null].filter(Boolean);
    const consumedIndex = thumbnailOn && firstText !== null ? firstTextIndex : -1;

    if (thumbnailOn && sectionTexts.length > 0) {
        const section = new SectionBuilder();
        for (const text of sectionTexts.slice(0, 3)) {
            section.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
        }
        const thumb = new ThumbnailBuilder().setURL(state.thumbnail.url.trim());
        if (state.thumbnail.description && state.thumbnail.description.trim()) {
            thumb.setDescription(state.thumbnail.description.trim().slice(0, 1024));
        }
        section.setThumbnailAccessory(thumb);
        container.addSectionComponents(section);
    } else if (headerText) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }

    state.blocks.forEach((block, index) => {
        if (index === consumedIndex) return;
        switch (block.type) {
            case 'text': {
                if ((block.content || '').trim()) {
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(applyPlaceholders(block.content, member))
                    );
                }
                break;
            }
            case 'separator': {
                const sep = new SeparatorBuilder()
                    .setDivider(block.divider !== false)
                    .setSpacing(block.spacing === 'Large' ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
                container.addSeparatorComponents(sep);
                break;
            }
            case 'media': {
                if (block.items.length > 0) {
                    const gallery = new MediaGalleryBuilder();
                    for (const item of block.items) {
                        const galleryItem = new MediaGalleryItemBuilder().setURL(item.url);
                        if (item.description && item.description.trim()) {
                            galleryItem.setDescription(item.description.trim().slice(0, 1024));
                        }
                        gallery.addItems(galleryItem);
                    }
                    container.addMediaGalleryComponents(gallery);
                }
                break;
            }
            case 'buttons': {
                if (block.buttons.length > 0) {
                    const row = new ActionRowBuilder();
                    for (const btn of block.buttons) {
                        const button = new ButtonBuilder()
                            .setStyle(ButtonStyle.Link)
                            .setLabel(btn.label)
                            .setURL(btn.url);
                        if (btn.emoji) button.setEmoji(btn.emoji);
                        row.addComponents(button);
                    }
                    container.addActionRowComponents(row);
                }
                break;
            }
            default:
                break;
        }
    });

    if (state.footer.enabled && state.footer.text.trim()) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${applyPlaceholders(state.footer.text, member)}`)
        );
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

// Whether the state produces any visible content (drives preview placeholder
// vs. real components, and gates sending).
function hasContent(state) {
    if (state.header.enabled && state.header.text.trim()) return true;
    if (state.footer.enabled && state.footer.text.trim()) return true;
    return state.blocks.some((block) => {
        if (block.type === 'text') return !!(block.content || '').trim();
        if (block.type === 'media') return block.items.length > 0;
        if (block.type === 'buttons') return block.buttons.length > 0;
        if (block.type === 'separator') return true;
        return false;
    });
}

module.exports = { buildMessage, hasContent };
