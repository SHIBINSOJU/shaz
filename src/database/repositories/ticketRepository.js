const { Ticket, TicketCounter } = require('../models/Ticket');
const { requireDatabase, isDatabaseReady } = require('../connection');

async function nextTicketNumber(guildId) {
    requireDatabase();
    const counter = await TicketCounter.findOneAndUpdate(
        { guildId },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    return counter.seq;
}

async function createTicket(data) {
    requireDatabase();
    return Ticket.create(data);
}

async function getTicketById(id) {
    if (!isDatabaseReady()) return null;
    try {
        return await Ticket.findById(id).lean();
    } catch {
        return null;
    }
}

async function getTicketByChannel(guildId, channelId) {
    if (!isDatabaseReady()) return null;
    try {
        return await Ticket.findOne({ guildId, channelId }).lean();
    } catch {
        return null;
    }
}

async function getOpenTicketsByUser(guildId, userId) {
    if (!isDatabaseReady()) return [];
    try {
        return await Ticket.find({ guildId, userId, status: { $in: ['open', 'claimed'] } })
            .sort({ createdAt: 1 })
            .lean();
    } catch {
        return [];
    }
}

async function countOpenTickets(guildId) {
    if (!isDatabaseReady()) return 0;
    try {
        return await Ticket.countDocuments({ guildId, status: { $in: ['open', 'claimed'] } });
    } catch {
        return 0;
    }
}

async function updateTicket(id, update) {
    requireDatabase();
    return Ticket.findByIdAndUpdate(id, update, { returnDocument: 'after' }).lean();
}

async function deleteTicket(id) {
    if (!isDatabaseReady()) return;
    try {
        await Ticket.findByIdAndDelete(id);
    } catch { /* already gone */ }
}

module.exports = {
    nextTicketNumber,
    createTicket,
    getTicketById,
    getTicketByChannel,
    getOpenTicketsByUser,
    countOpenTickets,
    updateTicket,
    deleteTicket
};
