const mongoose = require('mongoose');

// One document (key: 'global') persists the live Minecraft status across bot
// restarts so uptime and last-online data survive. Nothing here is per-guild:
// the monitored server is a single, config-defined instance.
const editionStateSchema = new mongoose.Schema({
    online: { type: Boolean, default: false },
    // Start of the CURRENT continuous online streak. Uptime = now - onlineSince.
    // Persisted so a restart does not reset or double-count uptime.
    onlineSince: { type: Date, default: null },
    // When the last online<->offline transition happened (for accurate edges).
    lastOnlineChange: { type: Date, default: null },
    lastChecked: { type: Date, default: null },
    playersOnline: { type: Number, default: 0 },
    playersMax: { type: Number, default: 0 },
    playerNames: { type: [String], default: [] },
    version: { type: String, default: null },
    protocol: { type: Number, default: null },
    ping: { type: Number, default: null },
    error: { type: String, default: null }
}, { _id: false });

const minecraftStatusSchema = new mongoose.Schema({
    key: { type: String, default: 'global', unique: true },
    java: { type: editionStateSchema, default: () => ({}) },
    bedrock: { type: editionStateSchema, default: () => ({}) },
    // Combined server-level view: online when EITHER edition answers. Drives the
    // single "Detected uptime" figure; kept separate from the per-edition data.
    server: {
        online: { type: Boolean, default: false },
        onlineSince: { type: Date, default: null },
        lastOnlineChange: { type: Date, default: null },
        lastChecked: { type: Date, default: null }
    },
    // ONE permanent public status message (edited in place, never duplicated).
    statusMessageId: { type: String, default: null },
    statusChannelId: { type: String, default: null },
    // Latest Java favicon data URL (data:image/png;base64,...) for the thumbnail.
    favicon: { type: String, default: null }
}, { timestamps: true });

module.exports = {
    MinecraftStatus: mongoose.models.MinecraftStatus || mongoose.model('MinecraftStatus', minecraftStatusSchema)
};
