module.exports = {
    name: 'autorole',
    commands: [
        require('./commands/autorole')
    ],
    events: [
        require('./events/guildMemberAdd')
    ],
    components: [
        require('./components/autoroleRouter')
    ]
};
