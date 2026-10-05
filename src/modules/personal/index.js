const { startSweeper, sweepDueReminders } = require('./services/delivery');

module.exports = {
    name: 'Personal',
    async initialize({ client }) {
        // Deliver reminders that became due while offline, then sweep
        // periodically. Guarded so harnesses without a client stay quiet.
        if (!client || typeof client.channels?.fetch !== 'function') return;
        await sweepDueReminders(client).catch(() => {});
        startSweeper(client);
    },
    commands: [
        require('./commands/afk'),
        require('./commands/remind'),
        require('./commands/reminders')
    ],
    events: [
        require('./events/messageCreate')
    ],
    components: [
        ...require('./components/routers')
    ]
};
