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
        .setName('avatar')
        .setDescription("Show a user's avatar.")
        .addUserOption(option =>
            option.setName('user').setDescription('Whose avatar to show (defaults to you)').setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const target = interaction.options.getUser('user') ?? interaction.user;
            const user = await interaction.client.users.fetch(target.id, { force: true }).catch(() => target);
            const member = interaction.inGuild()
                ? await interaction.guild.members.fetch(target.id).catch(() => null)
                : null;

            const url = (member?.displayAvatarURL({ size: 4096 }) ?? user.displayAvatarURL({ size: 4096 }));
            const animated = (member?.avatar ?? user.avatar)?.startsWith('a_') ?? false;
            const type = member?.avatar ? 'Server avatar' : (user.avatar ? 'Global avatar' : 'Default avatar');

            const container = new ContainerBuilder().setAccentColor(0x5865F2);
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 🖼️ Avatar — ${user.tag}`)
            );
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(url).setDescription(`Avatar of ${user.tag}`)
                )
            );
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Username:** ${user.username}\n**Type:** ${type}${animated ? ' (animated)' : ''}`
                )
            );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Open').setURL(url),
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('⬇️ Download').setURL(url)
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container, row]
            });
        } catch (error) {
            await fail(interaction, '/avatar', error);
        }
    }
};
