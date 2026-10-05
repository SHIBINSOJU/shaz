module.exports = {
    name: 'embed',
    commands: [
        require('./commands/embed'),
        require('./commands/embedconfig')
    ],
    events: [],
    components: [
        require('./components/embedRouter'),
        require('./modals/embedModals')
    ]
};
