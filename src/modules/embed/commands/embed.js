const {
    SlashCommandBuilder,
    MessageFlags,
    ChannelType
} = require('discord.js');
const logger = require('../../../core/logger');
const { getEmbedBuilderConfig } = require('../config');
const { createSession } = require('../services/sessionStore');
const { buildDashboard } = require('../services/dashboard');
const { canUseEmbed, DENY_MESSAGE } = require('../services/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('embed')
        .setDescription('Open the interactive Components V2 message builder.')
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('Channel to send the built message to (defaults to this channel)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        const builderConfig = getEmbedBuilderConfig();

        // Authorization first: owner → administrator → configured embed role.
        // No session is created for unauthorized users. The slash command is
        // intentionally visible to non-admins so allowed roles can invoke it;
        // this runtime check is the actual gate (Discord-side defaults alone
        // cannot express owner + role based access).
        const access = await canUseEmbed(interaction, builderConfig);
        if (!access.ok) {
            await interaction.reply({ content: DENY_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }

        const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!targetChannel || !targetChannel.isTextBased() || !targetChannel.viewable) {
            await interaction.reply({ content: '❌ That channel is not available for sending messages.', flags: MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const session = createSession({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                channelId: targetChannel.id,
                timeoutMs: builderConfig.sessionTimeoutMs
            });

            // Arm the expiry timer to disable the dashboard controls in place.
            const { buildExpiredNotice } = require('../services/dashboard');
            const { expireSession } = require('../services/sessionStore');
            clearTimeout(session.timeout);
            session.timeout = setTimeout(async () => {
                const expired = expireSession(session.id, 'timeout');
                if (!expired) return;
                try {
                    const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
                    const message = channel && session.messageId
                        ? await channel.messages.fetch(session.messageId).catch(() => null)
                        : null;
                    if (message) await message.edit(buildExpiredNotice());
                } catch (error) {
                    logger.warn(`Embed builder expiry edit failed: ${error.message}`);
                }
            }, builderConfig.sessionTimeoutMs);

            const reply = await interaction.editReply(buildDashboard(session, interaction.member));
            session.messageId = reply?.id || null;
        } catch (error) {
            logger.error(`/embed failed: ${error.stack || error}`);
            await interaction.editReply('❌ Could not open the message builder. Please try again.');
        }
    }
};
