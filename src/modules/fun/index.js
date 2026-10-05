module.exports = {
    name: 'Fun',
    commands: [
        require('./commands/8ball'),
        require('./commands/coinflip'),
        require('./commands/dice'),
        require('./commands/choose')
    ],
    events: [],
    components: []
};
