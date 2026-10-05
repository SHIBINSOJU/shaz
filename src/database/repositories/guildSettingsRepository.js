const GuildSettings = require('../models/GuildSettings');
const { isDatabaseReady } = require('../connection');

async function getGuildSettings(guildId) {
    if (!isDatabaseReady()) return null;
    try {
        return await GuildSettings.findOne({ guildId }).lean();
    } catch {
        return null;
    }
}

async function updateGuildSettings(guildId, update) {
    if (!isDatabaseReady()) {
        throw new Error('Database is not connected. Cannot update guild settings.');
    }
    return GuildSettings.findOneAndUpdate({ guildId }, update, { upsert: true, returnDocument: 'after' }).lean();
}

module.exports = {
    getGuildSettings,
    updateGuildSettings
};
