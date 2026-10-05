const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { canManage, MANAGE_DENY } = require('../services/access');
const { fail } = require('../../utility/services/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Send a message as the bot.')
        .addStringOption(option =>
            option.setName('message').setDescription('The message to send').setRequired(true).setMaxLength(2000))
        .addChannelOption(option =>
            option.setName('channel').setDescription('Where to send it (defaults to this channel)').setRequired(false)),

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
            let text = interaction.options.getString('message', true);
            const channel = interaction.options.getChannel('channel') ?? interaction.channel;
            if (!channel?.isTextBased()) {
                await interaction.editReply({ content: '❌ That channel cannot receive messages.' });
                return;
            }

            // Block @everyone/@here unless the user may mention them.
            const mentionsEveryone = /@(everyone|here)/.test(text);
            const mayPing = interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone) ?? false;
            if (mentionsEveryone && !mayPing) {
                text = text.replace(/@(everyone|here)/g, '@\u200b$1');
            }

            await channel.send({
                content: text,
                allowedMentions: mayPing ? undefined : { parse: ['users', 'roles'] }
            });
            await interaction.editReply({ content: `✅ Message sent in ${channel}.` });
        } catch (error) {
            logger.error(`/say failed: ${error?.stack || error}`);
            try {
                await interaction.editReply({ content: '❌ Could not send the message. Check my permissions in that channel.' });
            } catch {
                // Response window closed.
            }
        }
    }
};
