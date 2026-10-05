const createClientReadyEvent = require('./events/clientReady');
const createInteractionCreateEvent = require('./events/interactionCreate');

// The built-in "core" module provides the centralized clientReady
// (deployment + startup summary) and interactionCreate (command/component
// routing) events. It is registered through the same ModuleManager pipeline
// as feature modules, so it appears in startup statistics.
module.exports = function createCoreModule(ctx) {
    return {
        name: 'core',
        commands: [
            require('./commands/help')
        ],
        events: [
            createClientReadyEvent(ctx),
            createInteractionCreateEvent(ctx)
        ]
    };
};
