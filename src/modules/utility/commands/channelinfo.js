const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail, formatTimestamp, formatDuration } = require('../services/helpers');

const TYPE_NAMES = {
    [ChannelType.GuildText]: 'Text channel',
    [ChannelType.GuildVoice]: 'Voice channel',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement channel',
    [ChannelType.AnnouncementThread]: 'Announcement thread',
    [ChannelType.PublicThread]: 'Public thread',
    [ChannelType.PrivateThread]: 'Private thread',
    [ChannelType.GuildStageVoice]: 'Stage channel',
    [ChannelType.GuildForum]: 'Forum channel',
    [ChannelType.GuildMedia]: 'Media channel',
    [ChannelType.DM]: 'DM',
    [ChannelType.GroupDM]: 'Group DM'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('channelinfo')
        .setDescription('Show information about a channel.')
        .addChannelOption(option =>
            option.setName('channel').setDescription('Which channel (defaults to this one)').setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const channel = interaction.options.getChannel('channel') ?? interaction.channel;
            if (!channel) {
                await interaction.editReply({ content: '❌ Could not determine the channel.' });
                return;
            }

            const fields = [
                { label: 'Channel', value: `${channel}` },
                { label: 'Channel ID', value: `\`${channel.id}\`` },
                { label: 'Type', value: TYPE_NAMES[channel.type] ?? `Unknown (${channel.type})` },
                { label: 'Category', value: channel.parent ? `${channel.parent.name}` : '_None_' },
                { label: 'Position', value: `${channel.position ?? '—'}` },
                { label: 'Created', value: formatTimestamp(channel.createdAt) }
            ];
            if (typeof channel.rateLimitPerUser === 'number' && channel.rateLimitPerUser > 0) {
                fields.push({ label: 'Slowmode', value: formatDuration(channel.rateLimitPerUser * 1000) });
            }
            if (typeof channel.nsfw === 'boolean') {
                fields.push({ label: 'NSFW', value: channel.nsfw ? 'Yes 🔞' : 'No' });
            }
            if (channel.topic) {
                const topic = channel.topic.length > 200 ? channel.topic.slice(0, 197) + '...' : channel.topic;
                fields.push({ label: 'Topic', value: topic });
            }

            await interaction.editReply({
                ...buildInfoContainer({ header: `📺 #${channel.name ?? 'Channel'}`, fields, accent: 0x5865F2 }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/channelinfo', error);
        }
    }
};
