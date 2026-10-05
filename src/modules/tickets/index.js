module.exports = {
    name: 'tickets',
    commands: [
        require('./commands/ticket')
    ],
    events: [],
    components: [
        require('./components/ticketRouter'),
        require('./modals/ticketModals')
    ]
};
