const logger = require('../../../core/logger');
const reminderRepository = require('../../../database/repositories/reminderRepository');
const { formatTimestamp } = require('../../utility/services/helpers');

const SWEEP_MS = 30 * 1000;
const MAX_DELIVER_PER_SWEEP = 25;
let sweepTimer = null;

function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m`;
    if (total < 86400) return `${Math.floor(total / 3600)}h`;
    return `${Math.floor(total / 86400)}d`;
}

async function deliverReminder(client, reminder) {
    const content = `⏰ **Reminder:** ${reminder.message}\n-# Set ${formatTimestamp(reminder.createdAt)} • overdue by ${formatDuration(Date.now() - new Date(reminder.remindAt).getTime())}`;
    // Prefer DM; fall back to the origin channel mention.
    try {
        const user = await client.users.fetch(reminder.userId).catch(() => null);
        if (user) {
            await user.send({ content });
            return true;
        }
    } catch {
        // Closed DMs — fall through to the channel fallback.
    }
    try {
        const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
        if (channel?.isTextBased()) {
            await channel.send({ content: `<@${reminder.userId}> ${content}` }).catch(() => null);
            return true;
        }
    } catch {
        // Nowhere to deliver; still delete so it doesn't loop.
    }
    return false;
}

async function sweepDueReminders(client) {
    let due = [];
    try {
        due = await reminderRepository.getDueReminders();
    } catch {
        return;
    }
    for (const reminder of due.slice(0, MAX_DELIVER_PER_SWEEP)) {
        try {
            await deliverReminder(client, reminder);
        } catch (error) {
            logger.error(`Reminder delivery failed (${reminder._id}): ${error?.message || error}`);
        } finally {
            await reminderRepository.deleteReminderById(reminder._id);
        }
    }
}

function startSweeper(client) {
    if (sweepTimer) return;
    if (!client || typeof client.channels?.fetch !== 'function') return;
    sweepTimer = setInterval(() => {
        sweepDueReminders(client).catch(() => {});
    }, SWEEP_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

module.exports = { sweepDueReminders, startSweeper, deliverReminder };
