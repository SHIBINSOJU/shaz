module.exports = {
    name: 'Minecraft',
    commands: [
        require('./commands/serverip'),
        require('./commands/ip')
    ],
    events: [
        require('./events/messageCreate')
    ],
    components: [
        require('./components/minecraftRouter')
    ]
};
