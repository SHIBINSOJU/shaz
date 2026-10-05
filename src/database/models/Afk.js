const mongoose = require('mongoose');

const afkSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    reason: { type: String, required: true, maxlength: 500 },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

afkSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.Afk || mongoose.model('Afk', afkSchema);
