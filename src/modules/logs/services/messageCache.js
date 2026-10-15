// Tiny bounded cache of recent message content, used to show deleted text
// when the gateway event itself arrives uncached/partial. Never stores
// unlimited data: hard cap + TTL eviction. Content is only used for logging,
// never persisted.
const MAX_ENTRIES = 500;
const TTL_MS = 30 * 60 * 1000;

const cache = new Map(); // messageId -> { content, authorId, channelId, guildId, at }

function track(message) {
    try {
        if (!message?.id || message.author?.bot) {
            // Still track bot messages so deletes of bot messages can be
            // identified (and skipped) reliably — but keep them too.
        }
        if (!message?.id) return;
        cache.set(message.id, {
            content: typeof message.content === 'string' ? message.content.slice(0, 2000) : '',
            authorId: message.author?.id || null,
            authorTag: message.author?.tag || null,
            channelId: message.channelId || message.channel?.id || null,
            guildId: message.guildId || message.guild?.id || null,
            attachments: (message.attachments?.size || 0),
            at: Date.now()
        });
        if (cache.size > MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    } catch { /* never break message handling */ }
}

function recall(messageId) {
    const hit = cache.get(messageId);
    if (!hit) return null;
    if (Date.now() - hit.at > TTL_MS) {
        cache.delete(messageId);
        return null;
    }
    return hit;
}

function forget(messageId) {
    cache.delete(messageId);
}

setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of cache) {
        if (now - entry.at > TTL_MS) cache.delete(id);
        if (cache.size <= MAX_ENTRIES) break;
    }
}, 5 * 60 * 1000).unref?.();

module.exports = { track, recall, forget };
