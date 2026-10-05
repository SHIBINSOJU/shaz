const { MessageFlags } = require('discord.js');
const logger = require('../logger');
const { resolveComponent } = require('../componentHandler');
const { withRetry, isTransientError } = require('../../utils/retry');

module.exports = function createInteractionCreateEvent(ctx) {
    return {
        name: 'interactionCreate',
        async execute(interaction) {
            try {
                if (interaction.isChatInputCommand()) {
                    const command = ctx.moduleManager.commands.get(interaction.commandName);
                    if (!command) {
                        logger.warn(`Received unknown command interaction: /${interaction.commandName}`);
                        await interaction.reply({
                            content: '❌ This command is not available (its module may be disabled).',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    await command.execute(interaction, ctx);
                    return;
                }

                if (interaction.isAutocomplete()) {
                    const command = ctx.moduleManager.commands.get(interaction.commandName);
                    if (command && typeof command.autocomplete === 'function') {
                        await command.autocomplete(interaction, ctx);
                    }
                    return;
                }

                if (interaction.isMessageComponent()) {
                    const component = resolveComponent(ctx.moduleManager, interaction.customId);
                    if (!component) {
                        logger.warn(`No component handler registered for customId: ${interaction.customId}`);
                        return;
                    }
                    await component.execute(interaction, ctx);
                    return;
                }

                if (interaction.isModalSubmit()) {
                    const component = resolveComponent(ctx.moduleManager, interaction.customId);
                    if (component && typeof component.handleModal === 'function') {
                        await component.handleModal(interaction, ctx);
                    }
                    return;
                }
            } catch (error) {
                logger.error(`Interaction handling failed (${describe(interaction)}): ${error.stack || error}`);
                const payload = {
                    content: isTransientError(error)
                        ? '⚠️ Connection to Discord timed out. Please try again in a moment.'
                        : '❌ Something went wrong while handling this interaction.',
                    flags: MessageFlags.Ephemeral
                };
                await withRetry(async () => {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.followUp(payload);
                    } else {
                        await interaction.reply(payload);
                    }
                }, { attempts: 2 }).catch(() => {
                    // Response window already closed; error is logged above.
                });
            }
        }
    };
};

function describe(interaction) {
    if (interaction.isChatInputCommand?.()) return `/${interaction.commandName}`;
    if (interaction.customId) return `component ${interaction.customId}`;
    return interaction.type;
}
