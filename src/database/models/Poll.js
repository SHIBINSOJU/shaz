const mongoose = require('mongoose');

const pollOptionSchema = new mongoose.Schema({
    label: { type: String, required: true, maxlength: 80 },
    votes: { type: Number, default: 0 }
}, { _id: false });

const pollVoteSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    optionIndex: { type: Number, required: true }
}, { _id: false });

const pollSchema = new mongoose.Schema({
    pollId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null },
    userId: { type: String, required: true },
    question: { type: String, required: true, maxlength: 300 },
    options: { type: [pollOptionSchema], required: true },
    voters: { type: [pollVoteSchema], default: [] },
    endsAt: { type: Date, default: null, index: true },
    closed: { type: Boolean, default: false, index: true }
}, { timestamps: true });

module.exports = mongoose.models.Poll || mongoose.model('Poll', pollSchema);
