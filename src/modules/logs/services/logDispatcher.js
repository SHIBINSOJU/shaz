// Central log dispatcher. Every event handler funnels through sendLog():
// category enable check -> destination channel resolution (+ permission
// checks) -> Components V2 send with allowedMentions disabled.
// Never throws. Includes recursion, flood and duplicate guards.
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { withRetry } = require('../../../utils/retry');
const { getCategoryConfig, getAllLogChannelIds } = require('./logConfig');
const { isValidCategory } = require('../config');

// Recent payload hashes per guild+category to suppress double-fires
// (e.g. messageUpdate emitting twice for one edit).
const recentHashes = new Map();
const DEDUP_WINDOW_MS = 6000;

// Per-channel flood guard: max N logs per window, then drop + warn once.
const floodBuckets = new Map();
const FLOOD_MAX = 10;
const FLOOD_WINDOW_MS = 10_000;
let floodWarnedAt = 0;

function hashPayload(category, header, fieldSig) {
    let h = 0;
    const s = `${category}|${header}|${fieldSig}`;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
}

async function resolveDestination(guild, category) {
    const cfg = await getCategoryConfig(guild.id, category);
    if (!cfg.enabled) return null;
    if (!cfg.channelId) return null;

    let channel = null;
    try {
        channel = await withRetry(() => guild.channels.fetch(String(cfg.channelId)), { attempts: 2 });
    } catch {
        return null;
    }
    if (!channel || !channel.isTextBased?.()) return null;

    const me = guild.members?.me;
    const perms = channel.permissionsFor?.(me);
    if (perms && (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages))) {
        return null;
    }
    return channel;
}

/**
 * Send a Components V2 log entry to a category channel.
 * build: { emoji, title, accent, thumbnailUrl, fields, footer }
 * opts: { dedupKey } — when provided, identical keys within the window are dropped.
 */
async function sendLog(guild, category, build, opts = {}) {
    try {
        if (!guild?.id || !isValidCategory(category)) return false;

        // Recursion guard: never process anything if the guild disabled logging.
        const channel = await resolveDestination(guild, category);
        if (!channel) return false;

        const header = `${build.emoji || ''} ${build.title || ''}`.trim();
        const fieldSig = (build.fields || []).map(f => `${f.label}=${String(f.value).slice(0, 80)}`).join(';');
        const key = opts.dedupKey || `${guild.id}:${category}:${hashPayload(category, header, fieldSig)}`;

        const now = Date.now();
        if (recentHashes.has(key) && now - recentHashes.get(key) < DEDUP_WINDOW_MS) return false;
        recentHashes.set(key, now);
        if (recentHashes.size > 1000) {
            for (const [k, t] of recentHashes) {
                if (now - t > DEDUP_WINDOW_MS) recentHashes.delete(k);
            }
        }

        // Flood guard.
        const bucketKey = `${guild.id}:${channel.id}`;
        let bucket = floodBuckets.get(bucketKey);
        if (!bucket || now - bucket.start > FLOOD_WINDOW_MS) {
            bucket = { start: now, count: 0 };
            floodBuckets.set(bucketKey, bucket);
        }
        bucket.count += 1;
        if (bucket.count > FLOOD_MAX) {
            if (now - floodWarnedAt > 60_000) {
                floodWarnedAt = now;
                logger.warn(`Log flood guard: dropping ${category} logs for guild ${guild.id} (>${FLOOD_MAX}/10s).`);
            }
            return false;
        }

        const { buildLogMessage } = require('./logBuilders');
        const payload = buildLogMessage(build);

        await withRetry(() => channel.send({
            ...payload,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] }
        }), { attempts: 2 });
        return true;
    } catch (error) {
        logger.error(`Server log send failed [${category}]: ${error.message}`);
        return false;
    }
}

// True when the message lives in one of the guild's log channels
// (used to avoid logging the bot's own log output recursively).
async function isLogChannelMessage(message) {
    try {
        if (!message?.guildId || !message?.channelId) return false;
        const ids = await getAllLogChannelIds(message.guildId);
        return ids.has(String(message.channelId));
    } catch {
        return false;
    }
}

// Send one log entry to several categories, but only once per distinct
// destination channel (events like bans belong to both `member` and
// `moderation` without spamming a shared channel twice).
async function sendLogToCategories(guild, categories, build, opts = {}) {
    try {
        const channels = new Map(); // channelId -> channel
        for (const category of categories) {
            if (!isValidCategory(category)) continue;
            const channel = await resolveDestination(guild, category);
            if (channel && !channels.has(channel.id)) channels.set(channel.id, channel);
        }
        if (channels.size === 0) return false;

        const { buildLogMessage } = require('./logBuilders');
        const payload = buildLogMessage(build);
        let ok = false;
        for (const channel of channels.values()) {
            try {
                const now = Date.now();
                const bucketKey = `${guild.id}:${channel.id}`;
                let bucket = floodBuckets.get(bucketKey);
                if (!bucket || now - bucket.start > FLOOD_WINDOW_MS) {
                    bucket = { start: now, count: 0 };
                    floodBuckets.set(bucketKey, bucket);
                }
                bucket.count += 1;
                if (bucket.count > FLOOD_MAX) continue;
                await withRetry(() => channel.send({
                    ...payload,
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: { parse: [] }
                }), { attempts: 2 });
                ok = true;
            } catch (error) {
                logger.error(`Server log send failed [${categories.join('+')}]: ${error.message}`);
            }
        }
        return ok;
    } catch (error) {
        logger.error(`Server log fan-out failed: ${error.message}`);
        return false;
    }
}

module.exports = { sendLog, sendLogToCategories, resolveDestination, isLogChannelMessage };
