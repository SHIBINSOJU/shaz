const {
    SlashCommandBuilder,
    MessageFlags,
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
const { fail } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('banner')
        .setDescription("Show a user's Discord profile banner.")
        .addUserOption(option =>
            option.setName('user').setDescription('Whose banner to show (defaults to you)').setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const target = interaction.options.getUser('user') ?? interaction.user;
            const user = await interaction.client.users.fetch(target.id, { force: true }).catch(() => target);
            const url = user.bannerURL({ size: 4096 });

            if (!url) {
                await interaction.editReply({ content: `No profile banner found for **${user.tag}**.` });
                return;
            }

            const container = new ContainerBuilder().setAccentColor(user.accentColor ?? 0x5865F2);
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 🎆 Banner — ${user.tag}`)
            );
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(url).setDescription(`Banner of ${user.tag}`)
                )
            );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Open').setURL(url)
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container, row]
            });
        } catch (error) {
            await fail(interaction, '/banner', error);
        }
    }
};
