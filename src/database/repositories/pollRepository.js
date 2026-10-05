const crypto = require('crypto');
const Poll = require('../models/Poll');
const { requireDatabase, isDatabaseReady } = require('../connection');

function newId() {
    return crypto.randomBytes(6).toString('hex');
}

async function createPoll(data) {
    requireDatabase();
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await Poll.create({ ...data, pollId: newId() });
        } catch (error) {
            if (error?.code !== 11000 || attempt === 2) throw error;
        }
    }
}

async function getPoll(pollId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Poll.findOne({ pollId }).lean();
    } catch {
        return null;
    }
}

// Atomically moves a voter's vote (one active vote per user). Returns the
// updated poll, or null when the poll is closed/missing.
async function castVote(pollId, userId, optionIndex) {
    requireDatabase();
    const poll = await Poll.findOne({ pollId });
    if (!poll || poll.closed) return null;
    if (optionIndex < 0 || optionIndex >= poll.options.length) return null;

    const existing = poll.voters.find(v => v.userId === userId);
    if (existing) {
        if (existing.optionIndex === optionIndex) return poll.toObject();
        poll.options[existing.optionIndex].votes = Math.max(0, poll.options[existing.optionIndex].votes - 1);
        existing.optionIndex = optionIndex;
    } else {
        poll.voters.push({ userId, optionIndex });
    }
    poll.options[optionIndex].votes += 1;
    await poll.save();
    return poll.toObject();
}

async function setPollMessage(pollId, messageId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Poll.findOneAndUpdate({ pollId }, { messageId }, { returnDocument: 'after' }).lean();
    } catch {
        return null;
    }
}

async function closePoll(pollId) {
    requireDatabase();
    return Poll.findOneAndUpdate(
        { pollId, closed: false },
        { closed: true },
        { returnDocument: 'after' }
    ).lean();
}

async function findExpiredOpenPolls(now = new Date()) {
    if (!isDatabaseReady()) return [];
    try {
        return await Poll.find({ closed: false, endsAt: { $lte: now } }).lean();
    } catch {
        return [];
    }
}

module.exports = { createPoll, getPoll, castVote, setPollMessage, closePoll, findExpiredOpenPolls };
