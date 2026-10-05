const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { randomInt } = require('crypto');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail } = require('../../utility/services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('choose')
        .setDescription('Pick randomly from your choices.')
        .addStringOption(option =>
            option.setName('option1').setDescription('First choice').setRequired(true).setMaxLength(100))
        .addStringOption(option =>
            option.setName('option2').setDescription('Second choice').setRequired(true).setMaxLength(100))
        .addStringOption(option =>
            option.setName('option3').setDescription('Third choice').setRequired(false).setMaxLength(100))
        .addStringOption(option =>
            option.setName('option4').setDescription('Fourth choice').setRequired(false).setMaxLength(100))
        .addStringOption(option =>
            option.setName('option5').setDescription('Fifth choice').setRequired(false).setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const choices = ['option1', 'option2', 'option3', 'option4', 'option5']
                .map(name => interaction.options.getString(name))
                .filter(value => value && value.trim().length > 0);
            if (choices.length < 2) {
                await interaction.editReply({ content: '❌ Give me at least two choices to pick from.' });
                return;
            }
            const picked = choices[randomInt(choices.length)];
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '🎯 I choose:',
                    fields: [
                        { label: 'Choice', value: `**${picked}**` },
                        { label: 'Options', value: choices.map(c => `\`${c}\``).join(' ') }
                    ],
                    accent: 0x57F287
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/choose', error);
        }
    }
};
