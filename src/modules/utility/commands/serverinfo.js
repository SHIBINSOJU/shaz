const {
    SlashCommandBuilder,
    MessageFlags,
    ChannelType
} = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail, formatTimestamp, countMembers } = require('../services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Show information about this server.'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();
        try {
            const guild = interaction.guild;
            const owner = await guild.fetchOwner().catch(() => null);
            const channels = [...guild.channels.cache.values()];
            const text = channels.filter(c => c.type === ChannelType.GuildText).length;
            const voice = channels.filter(c => c.type === ChannelType.GuildVoice).length;
            const categories = channels.filter(c => c.type === ChannelType.GuildCategory).length;
            const { total, bots } = await countMembers(guild);

            await interaction.editReply({
                ...buildInfoContainer({
                    header: `🏠 ${guild.name}`,
                    fields: [
                        { label: 'Server ID', value: `\`${guild.id}\`` },
                        { label: 'Owner', value: owner ? `${owner.user.tag} (<@${owner.id}>)` : 'Unknown' },
                        { label: 'Created', value: formatTimestamp(guild.createdAt) },
                        { label: 'Members', value: `${total}` },
                        { label: 'Bots', value: `${bots}` },
                        { label: 'Channels', value: `${channels.length}` },
                        { label: 'Text channels', value: `${text}` },
                        { label: 'Voice channels', value: `${voice}` },
                        { label: 'Categories', value: `${categories}` },
                        { label: 'Roles', value: `${guild.roles.cache.size}` },
                        { label: 'Emojis', value: `${guild.emojis.cache.size}` },
                        { label: 'Boost level', value: `Level ${guild.premiumTier}` },
                        { label: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0}` }
                    ],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/serverinfo', error);
        }
    }
};
