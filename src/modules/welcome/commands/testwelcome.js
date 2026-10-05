const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const WelcomeBuilder = require('../services/WelcomeBuilder');
const { resolveWelcomeConfig } = require('../services/settings');
const { withRetry } = require('../../../utils/retry');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testwelcome')
        .setDescription('Preview the welcome message exactly as new members will see it.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to generate the preview for (defaults to you)')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({
                content: '❌ This command can only be used inside a server.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({
                content: '❌ You need **Manage Server** permission to use this command.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Discord REST calls can hit transient connect timeouts on flaky
        // networks — retry them instead of failing the interaction.
        try {
            await withRetry(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
        } catch (error) {
            if (!interaction.deferred && !interaction.replied) throw error;
        }

        try {
            const targetUser = interaction.options.getUser('user') ?? interaction.user;
            const member = await withRetry(() => interaction.guild.members.fetch(targetUser.id), { attempts: 2 }).catch(() => null);

            if (!member) {
                await withRetry(() => interaction.editReply({ content: '❌ Could not find that user in this server.' }), { attempts: 2 }).catch(() => {});
                return;
            }

            const config = await resolveWelcomeConfig(interaction.guild);
            // Identical builder as the real guildMemberAdd event — no duplicated UI code.
            const payload = await WelcomeBuilder.build(member, config);

            await withRetry(() => interaction.editReply({
                ...payload,
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            }));
        } catch (error) {
            logger.error(`/testwelcome failed: ${error.stack || error}`);
            await withRetry(() => interaction.editReply({ content: `❌ Failed to build the welcome preview: ${error.message}` }), { attempts: 2 }).catch(() => {});
        }
    }
};
