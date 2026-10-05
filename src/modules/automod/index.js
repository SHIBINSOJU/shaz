const { setActive } = require('./services/engine');
const { startSweep } = require('./services/trackers');

module.exports = {
    name: 'automod',
    async initialize() {
        // Marks the engine as the active link pipeline (the legacy antilink
        // listener defers to it) and starts tracker memory sweeps.
        setActive(true);
        startSweep();
    },
    commands: [
        require('./commands/automod')
    ],
    events: [
        require('./events/messageCreate'),
        require('./events/guildMemberAdd')
    ],
    components: []
};
