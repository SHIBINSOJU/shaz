const logger = require('../../core/logger');
const pollRepository = require('../../database/repositories/pollRepository');
const { buildPollPayload } = require('./services/pollView');

const SWEEP_MS = 60 * 1000;
let sweepTimer = null;

async function closeExpiredPolls(client) {
    let expired = [];
    try {
        expired = await pollRepository.findExpiredOpenPolls();
    } catch {
        return;
    }
    for (const poll of expired) {
        try {
            const closed = await pollRepository.closePoll(poll.pollId);
            if (!closed) continue;
            const channel = await client.channels.fetch(poll.channelId).catch(() => null);
            if (!channel?.isTextBased() || !closed.messageId) continue;
            const message = await channel.messages.fetch(closed.messageId).catch(() => null);
            if (message?.editable) {
                await message.edit(buildPollPayload(closed)).catch(() => {});
            }
        } catch (error) {
            logger.error(`Poll expiry sweep failed for ${poll.pollId}: ${error?.message || error}`);
        }
    }
}

module.exports = {
    name: 'Management',
    async initialize({ client }) {
        // Safety net: closes polls whose duration elapsed while offline.
        // Guarded so test harnesses without a real client never start timers.
        if (!client || typeof client.channels?.fetch !== 'function' || sweepTimer) return;
        await closeExpiredPolls(client).catch(() => {});
        sweepTimer = setInterval(() => {
            closeExpiredPolls(client).catch(() => {});
        }, SWEEP_MS);
        if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    },
    commands: [
        require('./commands/say'),
        require('./commands/announce'),
        require('./commands/poll'),
        require('./commands/suggest')
    ],
    events: [],
    components: [
        ...require('./components/routers')
    ]
};
