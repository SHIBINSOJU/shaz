const { MinecraftStatus } = require('../models/MinecraftStatus');
const { isDatabaseReady } = require('../connection');

// Persistence for the Minecraft status monitor. Every function degrades
// gracefully when MongoDB is unavailable — the monitor keeps running purely in
// memory and simply cannot survive a restart. Nothing here throws.

const KEY = 'global';

async function loadStatus() {
    if (!isDatabaseReady()) return null;
    try {
        return await MinecraftStatus.findOne({ key: KEY }).lean();
    } catch {
        return null;
    }
}

/** Upserts the whole status snapshot in one write. Returns true on success. */
async function saveStatus(state) {
    if (!isDatabaseReady()) return false;
    try {
        await MinecraftStatus.findOneAndUpdate(
            { key: KEY },
            {
                $set: {
                    java: state.java,
                    bedrock: state.bedrock,
                    server: state.server,
                    statusMessageId: state.statusMessageId ?? null,
                    statusChannelId: state.statusChannelId ?? null,
                    favicon: state.favicon ?? null
                }
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
        return true;
    } catch {
        return false;
    }
}

module.exports = { loadStatus, saveStatus };
