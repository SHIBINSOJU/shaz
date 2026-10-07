module.exports = {
    name: 'tickets',
    commands: [
        require('./commands/ticket'),
        require('./commands/delete'),
        require('./commands/close')
    ],
    events: [],
    components: [
        require('./components/ticketRouter'),
        require('./modals/ticketModals')
    ]
};
