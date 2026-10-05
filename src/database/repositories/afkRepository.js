const Afk = require('../models/Afk');
const { requireDatabase, isDatabaseReady } = require('../connection');

async function setAfk(guildId, userId, reason) {
    requireDatabase();
    return Afk.findOneAndUpdate(
        { guildId, userId },
        { reason, timestamp: new Date() },
        { upsert: true, returnDocument: 'after' }
    ).lean();
}

async function getAfk(guildId, userId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Afk.findOne({ guildId, userId }).lean();
    } catch {
        return null;
    }
}

async function clearAfk(guildId, userId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Afk.findOneAndDelete({ guildId, userId }).lean();
    } catch {
        return null;
    }
}

module.exports = { setAfk, getAfk, clearAfk };
