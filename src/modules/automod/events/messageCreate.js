const logger = require('../../../core/logger');
const { handleMessage } = require('../services/engine');

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        try {
            await handleMessage(message, client);
        } catch (error) {
            logger.error(`AutoMod messageCreate failed: ${error.message}`);
        }
    }
};
