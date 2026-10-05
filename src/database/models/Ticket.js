const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },
    channelId: { type: String, required: true, unique: true },
    // Stored channel name so logs never render "#unknown" after deletion.
    channelName: { type: String, default: null },
    openMessageId: { type: String, default: null },
    userId: { type: String, required: true, index: true },
    // Plain-text identity snapshots (never used as mentions).
    creatorUsername: { type: String, default: null },
    creatorDisplayName: { type: String, default: null },
    category: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    staffRoleIds: { type: [String], default: [] },
    claimedBy: { type: String, default: null },
    claimedByUsername: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    status: { type: String, enum: ['open', 'claimed', 'closed', 'deleted'], default: 'open', index: true },
    closedBy: { type: String, default: null },
    closedByUsername: { type: String, default: null },
    closeReason: { type: String, default: null },
    closedAt: { type: Date, default: null },
    reopenedBy: { type: String, default: null },
    reopenedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
    deletedByUsername: { type: String, default: null },
    deleteReason: { type: String, default: null },
    deletedAt: { type: Date, default: null },
    originalParentId: { type: String, default: null },
    statusMessageId: { type: String, default: null }
}, { timestamps: true });

ticketSchema.index({ guildId: 1, number: 1 }, { unique: true });
ticketSchema.index({ guildId: 1, userId: 1, status: 1 });

// Atomic per-guild ticket numbering (avoids duplicate numbers under concurrency).
const ticketCounterSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 }
});

module.exports = {
    Ticket: mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema),
    TicketCounter: mongoose.models.TicketCounter || mongoose.model('TicketCounter', ticketCounterSchema)
};
