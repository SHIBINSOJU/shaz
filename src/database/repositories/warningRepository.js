const Warning = require('../models/Warning');
const { requireDatabase } = require('../connection');

async function addWarning({ guildId, userId, moderatorId, reason }) {
    requireDatabase();
    const count = await Warning.countDocuments({ guildId, userId });
    const warningId = count + 1;
    return Warning.create({ guildId, userId, moderatorId, warningId, reason });
}

async function getWarnings(guildId, userId) {
    requireDatabase();
    return Warning.find({ guildId, userId }).sort({ warningId: 1 }).lean();
}

async function removeWarning(guildId, userId, warningId) {
    requireDatabase();
    return Warning.findOneAndDelete({ guildId, userId, warningId });
}

module.exports = {
    addWarning,
    getWarnings,
    removeWarning
};
