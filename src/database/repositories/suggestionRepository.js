const crypto = require('crypto');
const Suggestion = require('../models/Suggestion');
const { requireDatabase, isDatabaseReady } = require('../connection');

function newId() {
    return crypto.randomBytes(6).toString('hex');
}

async function createSuggestion(data) {
    requireDatabase();
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await Suggestion.create({ ...data, suggestionId: newId() });
        } catch (error) {
            if (error?.code !== 11000 || attempt === 2) throw error;
        }
    }
}

async function getSuggestion(suggestionId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Suggestion.findOne({ suggestionId }).lean();
    } catch {
        return null;
    }
}

async function reviewSuggestion(suggestionId, { status, reviewedBy }) {
    requireDatabase();
    return Suggestion.findOneAndUpdate(
        { suggestionId },
        { status, reviewedBy, reviewedAt: new Date() },
        { returnDocument: 'after' }
    ).lean();
}

async function setSuggestionMessage(suggestionId, messageId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Suggestion.findOneAndUpdate({ suggestionId }, { messageId }, { returnDocument: 'after' }).lean();
    } catch {
        return null;
    }
}

module.exports = { createSuggestion, getSuggestion, reviewSuggestion, setSuggestionMessage };
