const {
    SlashCommandBuilder,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder
} = require('discord.js');
const { fail, formatTimestamp } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Show information about a user.')
        .addUserOption(option =>
            option.setName('user').setDescription('Who to look up (defaults to you)').setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const target = interaction.options.getUser('user') ?? interaction.user;
            const member = interaction.inGuild()
                ? await interaction.guild.members.fetch(target.id).catch(() => null)
                : null;

            const roles = member
                ? [...member.roles.cache.values()]
                    .filter(r => r.id !== interaction.guild.id)
                    .sort((a, b) => b.position - a.position)
                : [];
            const roleList = roles.length > 0
                ? roles.slice(0, 15).map(r => `${r}`).join(' ') + (roles.length > 15 ? ` *+${roles.length - 15} more*` : '')
                : '_No roles_';

            const container = new ContainerBuilder().setAccentColor(member?.displayHexColor !== '#000000' ? member.displayColor : 0x5865F2);
            const section = new SectionBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 👤 ${target.tag}`)
            );
            const avatarUrl = member?.displayAvatarURL({ size: 256 }) ?? target.displayAvatarURL({ size: 256 });
            section.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl));
            container.addSectionComponents(section);
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent([
                    `**Username:** ${target.username}`,
                    `**Display name:** ${member?.displayName ?? target.displayName ?? target.username}`,
                    `**User ID:** \`${target.id}\``,
                    `**Account created:** ${formatTimestamp(target.createdAt)}`,
                    `**Joined server:** ${member?.joinedAt ? formatTimestamp(member.joinedAt) : '_Not in this server_'}`,
                    `**Highest role:** ${roles.length > 0 ? `${roles[0]}` : '_None_'}`,
                    `**Roles [${roles.length}]:** ${roleList}`,
                    `**Bot:** ${target.bot ? 'Yes 🤖' : 'No 👤'}`
                ].join('\n'))
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [container]
            });
        } catch (error) {
            await fail(interaction, '/userinfo', error);
        }
    }
};
