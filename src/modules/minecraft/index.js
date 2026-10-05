module.exports = {
    name: 'Minecraft',
    commands: [
        require('./commands/serverip')
    ],
    events: [
        require('./events/messageCreate')
    ],
    components: [
        require('./components/minecraftRouter')
    ]
};
