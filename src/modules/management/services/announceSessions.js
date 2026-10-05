const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const sessions = new Map();

function sweep() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
}

function createSession({ ownerId, guildId, channelId, payload }) {
    sweep();
    const id = crypto.randomBytes(6).toString('hex');
    sessions.set(id, { ownerId, guildId, channelId, payload, expiresAt: Date.now() + TTL_MS });
    return id;
}

function getSession(id) {
    sweep();
    return sessions.get(id) ?? null;
}

function consumeSession(id) {
    const session = getSession(id);
    if (session) sessions.delete(id);
    return session;
}

module.exports = { createSession, getSession, consumeSession };
