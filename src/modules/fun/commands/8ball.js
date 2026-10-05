const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { randomInt } = require('crypto');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { fail } = require('../../utility/services/helpers');

const ANSWERS = [
    '🎱 Definitely yes.',
    '🎱 Yes.',
    '🎱 Probably.',
    '🎱 Likely.',
    '🎱 Ask again later.',
    '🎱 Cannot say right now.',
    '🎱 Probably not.',
    '🎱 Unlikely.',
    '🎱 Definitely not.'
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('8ball')
        .setDescription('Ask the magic 8-ball a question.')
        .addStringOption(option =>
            option.setName('question').setDescription('Your yes/no question').setRequired(true).setMaxLength(300)),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const question = interaction.options.getString('question', true);
            const answer = ANSWERS[randomInt(ANSWERS.length)];
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '🎱 Magic 8-Ball',
                    fields: [
                        { label: 'Question', value: question },
                        { label: 'Answer', value: answer }
                    ],
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2]
            });
        } catch (error) {
            await fail(interaction, '/8ball', error);
        }
    }
};
