module.exports = {
    name: 'Minecraft',
    commands: [
        require('./commands/serverip')
    ],
    components: [
        require('./components/minecraftRouter')
    ]
};
