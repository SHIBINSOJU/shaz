const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const pollRepository = require('../../../database/repositories/pollRepository');
const { canManage, MANAGE_DENY } = require('../services/access');
const { buildPollPayload } = require('../services/pollView');
const { fail } = require('../../utility/services/helpers');

const MAX_OPTIONS = 5;
const MAX_DURATION_MIN = 60 * 24 * 7;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a community poll with voting buttons.')
        .addStringOption(o => o.setName('question').setDescription('The poll question').setRequired(true).setMaxLength(300))
        .addStringOption(o => o.setName('option1').setDescription('First choice').setRequired(true).setMaxLength(80))
        .addStringOption(o => o.setName('option2').setDescription('Second choice').setRequired(true).setMaxLength(80))
        .addStringOption(o => o.setName('option3').setDescription('Third choice').setRequired(false).setMaxLength(80))
        .addStringOption(o => o.setName('option4').setDescription('Fourth choice').setRequired(false).setMaxLength(80))
        .addStringOption(o => o.setName('option5').setDescription('Fifth choice').setRequired(false).setMaxLength(80))
        .addIntegerOption(o => o.setName('duration').setDescription('Voting time in minutes (omit = no limit)').setRequired(false).setMinValue(1).setMaxValue(MAX_DURATION_MIN))
        .addChannelOption(o => o.setName('channel').setDescription('Where to post the poll (defaults to this channel)').setRequired(false)),

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
            if (!(configService.get('polls.enabled', true))) {
                await interaction.editReply({ content: '❌ Polls are disabled.' });
                return;
            }

            const question = interaction.options.getString('question', true);
            const labels = ['option1', 'option2', 'option3', 'option4', 'option5']
                .map(name => interaction.options.getString(name))
                .filter(value => value && value.trim().length > 0)
                .slice(0, MAX_OPTIONS);
            if (labels.length < 2) {
                await interaction.editReply({ content: '❌ A poll needs at least two options.' });
                return;
            }
            const durationMin = interaction.options.getInteger('duration');
            const endsAt = durationMin ? new Date(Date.now() + durationMin * 60 * 1000) : null;

            const settings = await guildSettingsRepository.getGuildSettings(interaction.guild.id).catch(() => null);
            const configuredChannel = settings?.polls?.channelId || configService.get('polls.channelId', '');
            const channel = interaction.options.getChannel('channel')
                ?? (configuredChannel ? await interaction.guild.channels.fetch(configuredChannel).catch(() => null) : null)
                ?? interaction.channel;
            if (!channel?.isTextBased()) {
                await interaction.editReply({ content: '❌ That channel cannot receive polls.' });
                return;
            }

            const poll = await pollRepository.createPoll({
                guildId: interaction.guild.id,
                channelId: channel.id,
                userId: interaction.user.id,
                question,
                options: labels.map(label => ({ label, votes: 0 })),
                endsAt
            });

            const created = poll.toObject ? poll.toObject() : poll;
            const message = await channel.send(buildPollPayload(created));
            await pollRepository.setPollMessage(created.pollId, message.id);

            await interaction.editReply({ content: `✅ Poll posted in ${channel}.` });
        } catch (error) {
            await fail(interaction, '/poll', error, '❌ Could not create the poll. Is the database connected?');
        }
    }
};
