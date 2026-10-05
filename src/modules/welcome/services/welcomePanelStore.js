// In-memory draft store for the /welcome configuration panel.
//
// A draft only holds UNSAVED edits (and the ephemeral panel's owner). Nothing
// here is a configuration source: once 💾 Save runs, the values are written into
// the existing GuildSettings.welcome document through services/settings.js and
// the draft is dropped. Restarting the bot therefore never loses real settings.

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function sweep() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
}

function createSession({ userId, guildId, openedBy = 'admin', draft = {} }) {
    sweep();
    const id = crypto.randomBytes(6).toString('hex');
    sessions.set(id, { id, userId, guildId, openedBy, draft, expiresAt: Date.now() + TTL_MS });
    return sessions.get(id);
}

function getSession(id) {
    sweep();
    const session = sessions.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + TTL_MS; // keepalive while the panel is used
    return session;
}

function destroySession(id) {
    sessions.delete(id);
}

module.exports = { createSession, getSession, destroySession, TTL_MS };
