const mongoose = require('mongoose');

const suggestionSchema = new mongoose.Schema({
    suggestionId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null },
    userId: { type: String, required: true, index: true },
    content: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null }
}, { timestamps: true });

suggestionSchema.index({ guildId: 1, status: 1 });

module.exports = mongoose.models.Suggestion || mongoose.model('Suggestion', suggestionSchema);
