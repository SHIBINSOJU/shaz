const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    message: { type: String, required: true, maxlength: 1000 },
    remindAt: { type: Date, required: true, index: true }
}, { timestamps: true });

reminderSchema.index({ remindAt: 1 });

module.exports = mongoose.models.Reminder || mongoose.model('Reminder', reminderSchema);
