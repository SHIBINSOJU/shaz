const mongoose = require('mongoose');

// One row per published promotion. Used for duplicate protection: the same
// member cannot re-promote the same video ID within the configured window.
const videoPromotionSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    videoId: { type: String, required: true, index: true },
    kind: { type: String, enum: ['video', 'live'], default: 'video' }
}, { timestamps: { createdAt: true, updatedAt: false } });

videoPromotionSchema.index({ guildId: 1, userId: 1, videoId: 1, createdAt: -1 });

module.exports = mongoose.models.VideoPromotion
    || mongoose.model('VideoPromotion', videoPromotionSchema);
