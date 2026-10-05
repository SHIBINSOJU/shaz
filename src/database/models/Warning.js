const mongoose = require('mongoose');

const warningSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    moderatorId: { type: String, required: true },
    warningId: { type: Number, required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    timestamp: { type: Date, default: Date.now }
});

warningSchema.index({ guildId: 1, userId: 1, warningId: 1 }, { unique: true });

module.exports = mongoose.model('Warning', warningSchema);
