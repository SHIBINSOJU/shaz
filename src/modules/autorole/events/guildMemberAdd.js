// Registered through the existing ModuleManager like every other event.
// discord.js supports multiple listeners for the same event name, so this
// coexists with the welcome module's guildMemberAdd handler.

const logger = require('../../../core/logger');
const { resolveAutoroleConfig } = require('../config');
const { assignAutoroles } = require('../services/autoroleService');

module.exports = {
    name: 'guildMemberAdd',
    async execute(member) {
        try {
            const config = await resolveAutoroleConfig(member.guild);
            if (!config.enabled) return;
            if (member.user.bot && !config.bots) return;
            if (!config.roles || config.roles.length === 0) return;

            const delay = Math.max(0, Number(config.delay) || 0);
            if (delay > 0) {
                // Non-blocking: the event loop is never held while waiting.
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            // The member may have left during the delay — re-fetch first.
            const fresh = await member.guild.members.fetch(member.id).catch(() => null);
            if (!fresh) return;

            await assignAutoroles(fresh, config);
        } catch (error) {
            logger.error(`Autorole guildMemberAdd failed for ${member?.id ?? 'unknown'}: ${error.message}`);
        }
    }
};
