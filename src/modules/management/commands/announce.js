const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const logger = require('../../../core/logger');
const { canManage, MANAGE_DENY } = require('../services/access');
const { createSession } = require('../services/announceSessions');
const { fail } = require('../../utility/services/helpers');

function parseColor(input) {
    if (!input) return null;
    const hex = input.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return parseInt(hex, 16);
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Build and preview an announcement, then send it.')
        .addStringOption(o => o.setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(200))
        .addStringOption(o => o.setName('description').setDescription('Announcement body').setRequired(true).setMaxLength(2000))
        .addChannelOption(o => o.setName('channel').setDescription('Where to send it (defaults to this channel)').setRequired(false))
        .addStringOption(o => o.setName('image').setDescription('Image URL to attach').setRequired(false))
        .addStringOption(o => o.setName('color').setDescription('Accent color hex, e.g. #5865F2').setRequired(false))
        .addStringOption(o => o.setName('footer').setDescription('Footer line').setRequired(false).setMaxLength(200))
        .addRoleOption(o => o.setName('mention_role').setDescription('Role to mention').setRequired(false))
        .addBooleanOption(o => o.setName('ping_everyone').setDescription('Mention @everyone (needs Mention Everyone permission)').setRequired(false)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        const access = await canManage(interaction);
        if (!access.ok) {
            await interaction.reply({ content: MANAGE_DENY, flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const title = interaction.options.getString('title', true);
            const description = interaction.options.getString('description', true);
            const channel = interaction.options.getChannel('channel') ?? interaction.channel;
            const image = interaction.options.getString('image');
            const colorInput = interaction.options.getString('color');
            const footer = interaction.options.getString('footer');
            const mentionRole = interaction.options.getRole('mention_role');
            const pingEveryone = interaction.options.getBoolean('ping_everyone') ?? false;

            if (!channel?.isTextBased()) {
                await interaction.editReply({ content: '❌ That channel cannot receive messages.' });
                return;
            }
            if (image && !isHttpUrl(image)) {
                await interaction.editReply({ content: '❌ The image must be a valid http(s) URL.' });
                return;
            }
            const color = parseColor(colorInput);
            if (colorInput && color === null) {
                await interaction.editReply({ content: '❌ Color must be a hex value like `#5865F2`.' });
                return;
            }
            if (pingEveryone && !(interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone) ?? false)) {
                await interaction.editReply({ content: '❌ You need the **Mention Everyone** permission to ping @everyone.' });
                return;
            }

            const container = new ContainerBuilder().setAccentColor(color ?? 0x5865F2);
            const mentionLine = pingEveryone ? '@everyone\n\n' : mentionRole ? `${mentionRole}\n\n` : '';
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 📢 ${title}`)
            );
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`${mentionLine}${description}`)
            );
            if (image) {
                container.addMediaGalleryComponents(
                    new MediaGalleryBuilder().addItems(
                        new MediaGalleryItemBuilder().setURL(image).setDescription('Announcement image')
                    )
                );
            }
            if (footer) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
            }

            const allowedMentions = pingEveryone
                ? { parse: ['everyone'] }
                : mentionRole
                    ? { roles: [mentionRole.id] }
                    : undefined;

            const sessionId = createSession({
                ownerId: interaction.user.id,
                guildId: interaction.guild.id,
                channelId: channel.id,
                payload: {
                    flags: MessageFlags.IsComponentsV2,
                    components: [container],
                    ...(allowedMentions ? { allowedMentions } : {})
                }
            });

            const controls = new ContainerBuilder().setAccentColor(0x808080);
            controls.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# Preview — will be sent in ${channel} when you press **Send**.`)
            );
            controls.addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`announce:send:${sessionId}`).setLabel('📤 Send').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`announce:cancel:${sessionId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
                )
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container, controls]
            });
        } catch (error) {
            logger.error(`/announce failed: ${error?.stack || error}`);
            try {
                await interaction.editReply({ content: '❌ Could not build the announcement. Please try again.' });
            } catch {
                // Response window closed.
            }
        }
    }
};
