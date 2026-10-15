// Best-effort audit-log attribution. Never throws, never guesses: returns
// null when the bot lacks View Audit Log, when nothing recent matches, or
// when the entry target does not match the expected id.
const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');

const AUDIT_WINDOW_MS = 8000;

async function fetchAuditEntry(guild, type, targetId = null) {
    try {
        const me = guild.members?.me;
        if (me && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

        const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
        if (!logs?.entries) return null;

        const now = Date.now();
        for (const entry of logs.entries.values()) {
            if (now - entry.createdTimestamp > AUDIT_WINDOW_MS) continue;
            if (targetId && entry.target?.id && String(entry.target.id) !== String(targetId)) continue;
            if (targetId && entry.targetId && String(entry.targetId) !== String(targetId)) continue;
            return entry;
        }
        return null;
    } catch (error) {
        logger.warn(`Audit log lookup failed (${String(type)}): ${error.message}`);
        return null;
    }
}

function executorLine(entry) {
    if (!entry?.executor) return null;
    return `${entry.executor} (\`${entry.executor.id}\`)`;
}

module.exports = { fetchAuditEntry, executorLine, AUDIT_WINDOW_MS };
