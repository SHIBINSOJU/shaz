const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const configService = require('../../../core/configService');
const reminderRepository = require('../../../database/repositories/reminderRepository');
const { parseDuration, describeDuration } = require('../services/durations');
const { fail, formatTimestamp } = require('../../utility/services/helpers');
const { buildInfoContainer } = require('../../../utils/componentsV2');

const MAX_ACTIVE = 10;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set a personal reminder.')
        .addStringOption(option =>
            option.setName('duration').setDescription('When to remind you: 30s, 15m, 2h, 7d').setRequired(true).setMaxLength(10))
        .addStringOption(option =>
            option.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(1000)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (!(configService.get('reminders.enabled', true))) {
                await interaction.editReply({ content: '❌ Reminders are disabled.' });
                return;
            }
            const ms = parseDuration(interaction.options.getString('duration', true));
            if (ms === null) {
                await interaction.editReply({ content: '❌ Invalid duration. Use a number plus `s`, `m`, `h`, or `d` (e.g. `30m`, max 30 days).' });
                return;
            }
            const count = await reminderRepository.countUserReminders(interaction.guild.id, interaction.user.id);
            if (count >= MAX_ACTIVE) {
                await interaction.editReply({ content: `❌ You already have ${MAX_ACTIVE} active reminders. Cancel one with \`/reminders\` first.` });
                return;
            }
            const remindAt = new Date(Date.now() + ms);
            const reminder = await reminderRepository.createReminder({
                guildId: interaction.guild.id,
                channelId: interaction.channelId,
                userId: interaction.user.id,
                message: interaction.options.getString('message', true).trim(),
                remindAt
            });
            const created = reminder.toObject ? reminder.toObject() : reminder;
            await interaction.editReply({
                ...buildInfoContainer({
                    header: '⏰ Reminder set',
                    fields: [
                        { label: 'In', value: describeDuration(ms) },
                        { label: 'At', value: formatTimestamp(remindAt) },
                        { label: 'Message', value: created.message },
                        { label: 'ID', value: `\`${created._id}\`` }
                    ],
                    footer: 'I will DM you. If your DMs are closed, I will ping you here instead.',
                    accent: 0x5865F2
                }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            });
        } catch (error) {
            await fail(interaction, '/remind', error, '❌ Could not set the reminder. Is the database connected?');
        }
    }
};
