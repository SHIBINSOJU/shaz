module.exports = {
    name: 'Utility',
    commands: [
        require('./commands/avatar'),
        require('./commands/banner'),
        require('./commands/userinfo'),
        require('./commands/serverinfo'),
        require('./commands/roleinfo'),
        require('./commands/channelinfo'),
        require('./commands/ping'),
        require('./commands/uptime'),
        require('./commands/botinfo'),
        require('./commands/servericon'),
        require('./commands/membercount')
    ],
    events: [],
    components: []
};
