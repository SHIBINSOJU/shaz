// /welcome — the Discord control panel for the EXISTING welcome system.
//
// It stores nothing itself: reads go through services/settings.js (config.yml →
// GuildSettings.welcome) and the previews go through the production
// WelcomeBuilder, so the automatic guildMemberAdd welcome stays the single
// source of truth and the card renderer stays untouched.

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { withRetry } = require('../../../utils/retry');
const { openPanel, renderMainPanel } = require('../services/welcomePanelSession');

const DENY = '❌ You don\'t have permission to configure the welcome system.';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure the welcome system: channel, message, thumbnail, separator and welcome card.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({
                content: '❌ This command can only be used inside a server.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Slash-command gate; every button, select and modal re-checks it in
        // components/welcomeRouter.js.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: DENY, flags: MessageFlags.Ephemeral });
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
            const session = openPanel(interaction);
            const payload = await renderMainPanel(session, interaction.guild);
            await withRetry(() => interaction.editReply(payload), { attempts: 2 });
        } catch (error) {
            logger.error(`/welcome failed: ${error.stack || error}`);
            await withRetry(
                () => interaction.editReply({
                    content: `❌ Could not open the welcome settings: ${String(error.message ?? error).slice(0, 180)}`
                }),
                { attempts: 2 }
            ).catch(() => { /* response window closed */ });
        }
    }
};
