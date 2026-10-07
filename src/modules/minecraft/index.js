const logger = require('../../core/logger');
const statusMonitor = require('./services/statusMonitor');

module.exports = {
    name: 'Minecraft',
    commands: [
        require('./commands/serverip'),
        require('./commands/ip'),
        require('./commands/mcstatus')
    ],
    events: [
        require('./events/messageCreate')
    ],
    components: [
        require('./components/minecraftRouter')
    ],

    // Starts the automatic status monitor once the bot is ready. Reuses the
    // existing module lifecycle hook — no new event, no duplicate handler.
    // The ready client is passed through so the monitor can maintain the ONE
    // permanent status message (create once, edit in place).
    async initialize({ client } = {}) {
        const begin = (readyClient) => {
            statusMonitor.start(readyClient || client || null).catch((error) => {
                logger.error(`Minecraft status monitor failed to start: ${error.message}`);
            });
        };
        if (client && typeof client.once === 'function') {
            client.once('clientReady', begin);
        } else {
            begin();
        }
    }
};
