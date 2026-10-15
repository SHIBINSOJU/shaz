const memberEvents = require('./events/memberEvents');
const guildMemberUpdate = require('./events/guildMemberUpdate');
const messageEvents = require('./events/messageEvents');
const messageCreate = require('./events/messageCreate');
const voiceStateUpdate = require('./events/voiceStateUpdate');
const channelEvents = require('./events/channelEvents');
const roleEvents = require('./events/roleEvents');
const serverEvents = require('./events/serverEvents');

module.exports = {
    name: 'Logs',
    commands: [
        require('./commands/logs')
    ],
    // One listener per gateway event — centralized through logDispatcher,
    // so no duplicate registrations and no cross-module interference.
    events: [
        messageCreate,
        memberEvents.guildMemberAdd,
        memberEvents.guildMemberRemove,
        memberEvents.guildBanAdd,
        memberEvents.guildBanRemove,
        guildMemberUpdate,
        messageEvents.messageDelete,
        messageEvents.messageUpdate,
        messageEvents.messageDeleteBulk,
        voiceStateUpdate,
        channelEvents.channelCreate,
        channelEvents.channelDelete,
        channelEvents.channelUpdate,
        channelEvents.threadCreate,
        channelEvents.threadDelete,
        channelEvents.threadUpdate,
        roleEvents.roleCreate,
        roleEvents.roleDelete,
        roleEvents.roleUpdate,
        serverEvents.guildUpdate,
        serverEvents.inviteCreate,
        serverEvents.inviteDelete,
        serverEvents.emojiCreate,
        serverEvents.emojiDelete,
        serverEvents.emojiUpdate,
        serverEvents.stickerCreate,
        serverEvents.stickerDelete,
        serverEvents.stickerUpdate,
        serverEvents.guildScheduledEventCreate,
        serverEvents.guildScheduledEventUpdate,
        serverEvents.guildScheduledEventDelete,
        serverEvents.webhooksUpdate
    ],
    components: [
        require('./components/logsRouter')
    ]
};
