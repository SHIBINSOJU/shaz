const { buildIpCommandData, executeIpCommand } = require('./serverip');

// `/ip` is a second NAME for the same command, not a second implementation:
// identical options, identical handler, identical ephemeral response path.
module.exports = {
    data: buildIpCommandData('ip'),
    execute: executeIpCommand,
};
