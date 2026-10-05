module.exports = {
    name: 'antilink',
    commands: [
        require('./commands/antilink')
    ],
    events: [
        require('./events/messageCreate')
    ],
    components: []
};
