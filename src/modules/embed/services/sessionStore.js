// Per-user builder sessions. Each /embed invocation gets an isolated session
// (own state + own custom-ID namespace), so concurrent builders never
// interfere. Sessions expire after the configured timeout; expiry disables
// the dashboard controls and frees memory.

const crypto = require('crypto');
const logger = require('../../../core/logger');
const { createDefaultState } = require('./state');

const sessions = new Map();

function createSession({ userId, guildId, channelId, timeoutMs }) {
    const id = crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    const session = {
        id,
        userId,
        guildId,
        channelId,
        messageId: null,
        state: createDefaultState(),
        pendingAction: null, // 'edit' | 'remove' | 'up' | 'down' | null (block-picker select)
        createdAt: now,
        expiresAt: now + timeoutMs,
        timeout: null
    };
    session.timeout = setTimeout(() => expireSession(id, 'timeout'), timeoutMs);
    sessions.set(id, session);
    return session;
}

function getSession(id) {
    const session = sessions.get(id) || null;
    if (!session) return null;
    if (Date.now() >= session.expiresAt) {
        expireSession(id, 'lazy');
        return null;
    }
    return session;
}

function destroySession(id) {
    const session = sessions.get(id);
    if (!session) return;
    if (session.timeout) clearTimeout(session.timeout);
    sessions.delete(id);
}

// Fired by the expiry timer: marks the session expired so the next
// interaction (or the timer handler) can disable the dashboard.
function expireSession(id, reason) {
    const session = sessions.get(id);
    if (!session) return null;
    if (session.timeout) clearTimeout(session.timeout);
    sessions.delete(id);
    logger.info(`Embed builder session ${id} expired (${reason}).`);
    return session; // returned so the timer callback can disable the dashboard message
}

function touchSessionExpiry(session, onExpire) {
    // Re-arm helper if sliding expiry is ever desired; currently fixed-window.
    return session;
}

module.exports = {
    createSession,
    getSession,
    destroySession,
    expireSession,
    touchSessionExpiry,
    _sessions: sessions
};
