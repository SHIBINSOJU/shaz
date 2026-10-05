const logger = require('../../../core/logger');
const { recordJoin } = require('../services/engine');

module.exports = {
    name: 'guildMemberAdd',
    async execute(member, client) {
        try {
            await recordJoin(member, client);
        } catch (error) {
            logger.error(`AutoMod guildMemberAdd failed: ${error.message}`);
        }
    }
};
