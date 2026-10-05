const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const configService = require('../../../core/configService');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const suggestionRepository = require('../../../database/repositories/suggestionRepository');
const { buildSuggestionPayload } = require('../services/suggestView');
const { fail } = require('../../utility/services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Submit a suggestion for staff to review.')
        .addStringOption(option =>
            option.setName('suggestion').setDescription('Your suggestion').setRequired(true).setMaxLength(1000)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (!(configService.get('suggestions.enabled', true))) {
                await interaction.editReply({ content: '❌ Suggestions are disabled.' });
                return;
            }
            const content = interaction.options.getString('suggestion', true).trim();
            if (content.length < 5) {
                await interaction.editReply({ content: '❌ Please describe your suggestion in a bit more detail.' });
                return;
            }

            const settings = await guildSettingsRepository.getGuildSettings(interaction.guild.id).catch(() => null);
            const configuredChannel = settings?.suggestions?.channelId || configService.get('suggestions.channelId', '');
            const channel = configuredChannel
                ? await interaction.guild.channels.fetch(configuredChannel).catch(() => null)
                : interaction.channel;
            if (!channel?.isTextBased()) {
                await interaction.editReply({ content: '❌ The suggestion channel is unavailable.' });
                return;
            }

            const suggestion = await suggestionRepository.createSuggestion({
                guildId: interaction.guild.id,
                channelId: channel.id,
                userId: interaction.user.id,
                content
            });
            const created = suggestion.toObject ? suggestion.toObject() : suggestion;
            const message = await channel.send(buildSuggestionPayload(created));
            await suggestionRepository.setSuggestionMessage(created.suggestionId, message.id);

            await interaction.editReply({ content: `✅ Suggestion posted in ${channel}. Staff will review it soon.` });
        } catch (error) {
            await fail(interaction, '/suggest', error, '❌ Could not post the suggestion. Is the database connected?');
        }
    }
};
