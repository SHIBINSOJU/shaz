// Duplicate-promotion tracking. Uses MongoDB when connected; falls back to
// a bounded in-memory store so the feature keeps working without a database.
// Never throws — database errors resolve to "no duplicate found" and are
// logged by the caller.

const { isDatabaseReady } = require('../connection');
const VideoPromotion = require('../models/VideoPromotion');

// Fallback store: [{ guildId, userId, videoId, at }] (pruned, max 2000).
const memoryStore = [];
const MEMORY_MAX = 2000;

function pruneMemory(now = Date.now()) {
    while (memoryStore.length > MEMORY_MAX) memoryStore.shift();
    for (let i = memoryStore.length - 1; i >= 0; i--) {
        if (now - memoryStore[i].at > 24 * 3600 * 1000) memoryStore.splice(i, 1);
    }
}

async function findRecentPromotion(guildId, userId, videoId, windowSeconds) {
    const cutoff = new Date(Date.now() - Math.max(0, windowSeconds) * 1000);
    if (isDatabaseReady()) {
        try {
            return await VideoPromotion.findOne({
                guildId,
                userId,
                videoId,
                createdAt: { $gte: cutoff }
            }).lean();
        } catch {
            // Fall through to the memory store.
        }
    }
    pruneMemory();
    return memoryStore.find(
        (e) => e.guildId === guildId && e.userId === userId && e.videoId === videoId && e.at >= cutoff.getTime()
    ) || null;
}

async function recordPromotion(guildId, userId, videoId, kind) {
    if (isDatabaseReady()) {
        try {
            await VideoPromotion.create({ guildId, userId, videoId, kind });
            return;
        } catch {
            // Fall through to the memory store.
        }
    }
    pruneMemory();
    memoryStore.push({ guildId, userId, videoId, at: Date.now() });
    pruneMemory();
}

module.exports = { findRecentPromotion, recordPromotion };
