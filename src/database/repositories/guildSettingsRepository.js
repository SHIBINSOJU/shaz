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

async function getGlobalMinecraftSettings() {
    if (!isDatabaseReady()) return null;
    try {
        const doc = await GuildSettings.findOne({ guildId: 'global' }).lean();
        return doc?.minecraft || null;
    } catch {
        return null;
    }
}

async function updateGlobalMinecraftSettings(minecraftUpdate) {
    if (!isDatabaseReady()) {
        throw new Error('Database is not connected. Cannot update minecraft settings.');
    }
    return GuildSettings.findOneAndUpdate(
        { guildId: 'global' },
        { $set: { minecraft: minecraftUpdate } },
        { upsert: true, returnDocument: 'after' }
    ).lean();
}

module.exports = {
    getGuildSettings,
    updateGuildSettings,
    getGlobalMinecraftSettings,
    updateGlobalMinecraftSettings
};
