module.exports = {
    name: 'Moderation',
    commands: [
        require('./commands/ban'),
        require('./commands/unban'),
        require('./commands/kick'),
        require('./commands/timeout'),
        require('./commands/warn'),
        require('./commands/unwarn'),
        require('./commands/warnings'),
        require('./commands/clear'),
        require('./commands/lock'),
        require('./commands/unlock'),
        require('./commands/slowmode')
    ],
    events: [],
    components: []
};
