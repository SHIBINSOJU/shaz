const logger = require('../../core/logger');
const { validateWelcomeGif } = require('./services/welcomeMedia');

module.exports = {
    name: 'Welcome',

    // Runs once when the module is registered: validates the GIF configuration
    // up front so problems are visible at startup instead of at first welcome.
    async initialize({ config }) {
        const result = validateWelcomeGif(config.get('welcome', {}) || {});
        if (result.ok) {
            logger.info(`Welcome GIF: ${result.message}`);
        } else {
            logger.warn(`Welcome GIF: ${result.message}`);
        }
    },

    commands: [
        require('./commands/welcome'),
        require('./commands/testwelcome')
    ],
    events: [
        require('./events/guildMemberAdd')
    ],
    components: [
        require('./components/welcomeRouter')
    ]
};
