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
        .setName('servericon')
        .setDescription("Show the server's icon."),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        try {
            const url = interaction.guild.iconURL({ size: 4096 });
            if (!url) {
                await interaction.editReply({ content: '❌ This server has no icon.' });
                return;
            }

            const container = new ContainerBuilder().setAccentColor(0x5865F2);
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 🖼️ ${interaction.guild.name}`)
            );
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(url).setDescription('Server icon')
                )
            );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Full resolution').setURL(url)
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container, row]
            });
        } catch (error) {
            await fail(interaction, '/servericon', error);
        }
    }
};
