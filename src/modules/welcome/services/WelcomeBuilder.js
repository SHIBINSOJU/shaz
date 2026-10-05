const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    AttachmentBuilder,
    MessageFlags
} = require('discord.js');
const { fillPlaceholders } = require('../../../utils/placeholders');
const { resolveWelcomeMedia } = require('./welcomeMedia');
const { composeWelcomeCard } = require('./welcomeCard');

function parseColor(color) {
    if (typeof color === 'number') return color;
    if (typeof color === 'string') {
        const hex = color.replace('#', '');
        const parsed = parseInt(hex, 16);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
}

/**
 * Builds the welcome UI with Discord Components V2 (no embeds).
 * Used by BOTH the guildMemberAdd event and /testwelcome so the
 * preview is always identical to the real message.
 */
class WelcomeBuilder {
    static async build(member, config = {}) {
        const container = new ContainerBuilder();

        // Existing divider lines, now switchable from the /welcome panel.
        // Defaults to on, so configs without the key render exactly as before.
        const showSeparators = config.separatorEnabled !== false;

        const accent = parseColor(config.accentColor);
        if (accent !== null) container.setAccentColor(accent);

        if (config.title) {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`# ${fillPlaceholders(config.title, member)}`)
            );
            if (showSeparators) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
            }
        }

        // 🔝 Intro text ABOVE the existing welcome card. Only the copy changes —
        // the card, GIF, renderer, separators and footer below are untouched.
        // The third line is the configured welcome message (config.description,
        // edited through the /welcome "Edit Message" field), so it stays
        // admin-editable and is no longer repeated below the card. The mention
        // goes through the existing placeholder system; allowedMentions on the
        // payload below limits pings to this member only.
        const introParts = [
            '🎮 Welcome to our Blocky Universe!',
            `Hey ${fillPlaceholders('{mention}', member)} 👋`
        ];
        const introMessage = config.description ? fillPlaceholders(config.description, member) : '';
        if (introMessage) introParts.push(introMessage);

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(introParts.join('\n\n'))
        );

        // Main visual: the member's name baked into a copy of the GIF (inside the
        // white card), else the configured GIF as-is (url or local file), else the
        // legacy static image config, else no media.
        const files = [];
        let nameInCard = false;

        const card = config.usernameInCard === false
            ? null
            : await composeWelcomeCard(member, config).catch(() => null);

        if (card) {
            nameInCard = true;
            files.push(new AttachmentBuilder(card, { name: 'welcome-card.gif' }));
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://welcome-card.gif')
                )
            );
        } else {
            const media = resolveWelcomeMedia(config);
            if (media) {
                container.addMediaGalleryComponents(
                    new MediaGalleryBuilder().addItems(
                        new MediaGalleryItemBuilder().setURL(media.url)
                    )
                );
                files.push(...media.files);
            } else if (config.image?.enabled && config.image?.url) {
                container.addMediaGalleryComponents(
                    new MediaGalleryBuilder().addItems(
                        new MediaGalleryItemBuilder().setURL(config.image.url)
                    )
                );
            }
        }

        // With the name inside the card the greeting line would only duplicate it.
        // The configured message renders in the intro ABOVE the card, so it is not
        // repeated here.
        const bodyParts = [];
        if (!nameInCard && config.greeting) bodyParts.push(fillPlaceholders(config.greeting, member));

        if (bodyParts.length > 0) {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(bodyParts.join('\n\n'))
            );
        }

        if (config.footer?.enabled && config.footer?.text) {
            if (showSeparators) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
            }
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# ${fillPlaceholders(config.footer.text, member)}`)
            );
        }

        return {
            flags: MessageFlags.IsComponentsV2,
            components: [container],
            // Only the joining member may be pinged — never roles, staff,
            // @everyone or @here (the new member IS intentionally mentioned
            // in the intro line above).
            allowedMentions: { parse: [], users: [member.id] },
            ...(files.length > 0 ? { files } : {})
        };
    }
}

module.exports = WelcomeBuilder;
