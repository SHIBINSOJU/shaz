// In-memory rolling-window tracking for spam/duplicate/raid detection and
// warning cooldowns. No database queries — short-term state only.
//
// Memory safety: per-guild maps capped in size, entries pruned lazily on
// access plus a periodic sweep started by the module's initialize().

const MAX_USERS_PER_GUILD = 2000;
const MAX_GUILDS_TRACKED = 200;

// `${guildId}:${userId}` -> array of message timestamps (ms)
const messageWindows = new Map();
// `${guildId}:${userId}` -> array of { hash, at }
const duplicateHistory = new Map();
// guildId -> array of join timestamps (ms)
const joinWindows = new Map();
// `${guildId}:${userId}:${rule}` -> timestamp of last warning (ms)
const warnCooldowns = new Map();
// guildId -> timestamp of last raid alert (ms)
const raidAlerts = new Map();

function key(guildId, userId, extra = '') {
    return `${guildId}:${userId}${extra ? `:${extra}` : ''}`;
}

function pruneArray(arr, cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
}

function capGuilds(map) {
    if (map.size <= MAX_GUILDS_TRACKED * 4) return;
    const keys = [...map.keys()].slice(0, map.size - MAX_GUILDS_TRACKED * 4);
    for (const k of keys) map.delete(k);
}

function capUsers(map, guildId) {
    let count = 0;
    for (const k of map.keys()) {
        if (k.startsWith(`${guildId}:`)) count++;
    }
    if (count <= MAX_USERS_PER_GUILD) return;
    for (const k of map.keys()) {
        if (k.startsWith(`${guildId}:`)) {
            map.delete(k);
            if (--count <= MAX_USERS_PER_GUILD) break;
        }
    }
}

// Records a message timestamp; returns count within the window (inclusive).
function recordMessage(guildId, userId, intervalSeconds, now = Date.now()) {
    const k = key(guildId, userId);
    let arr = messageWindows.get(k);
    if (!arr) {
        capUsers(messageWindows, guildId);
        capGuilds(messageWindows);
        arr = [];
        messageWindows.set(k, arr);
    }
    arr.push(now);
    pruneArray(arr, now - intervalSeconds * 1000);
    return arr.length;
}

// Records a normalized content hash; returns occurrences within the window.
function recordDuplicate(guildId, userId, hash, intervalSeconds, now = Date.now()) {
    const k = key(guildId, userId);
    let arr = duplicateHistory.get(k);
    if (!arr) {
        capUsers(duplicateHistory, guildId);
        capGuilds(duplicateHistory);
        arr = [];
        duplicateHistory.set(k, arr);
    }
    arr.push({ hash, at: now });
    const cutoff = now - intervalSeconds * 1000;
    let i = 0;
    while (i < arr.length && arr[i].at < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    let count = 0;
    for (const entry of arr) {
        if (entry.hash === hash) count++;
    }
    return count;
}

// Records a guild join; returns joins within the window.
function recordJoin(guildId, intervalSeconds, now = Date.now()) {
    let arr = joinWindows.get(guildId);
    if (!arr) {
        capGuilds(joinWindows);
        arr = [];
        joinWindows.set(guildId, arr);
    }
    arr.push(now);
    pruneArray(arr, now - intervalSeconds * 1000);
    return arr.length;
}

// True once per cooldown window per user+rule (first call returns true).
function checkWarnCooldown(guildId, userId, rule, cooldownSeconds, now = Date.now()) {
    const k = key(guildId, userId, rule);
    const last = warnCooldowns.get(k) || 0;
    if (now - last < cooldownSeconds * 1000) return false;
    warnCooldowns.set(k, now);
    if (warnCooldowns.size > MAX_GUILDS_TRACKED * 8) {
        for (const [ck, ts] of warnCooldowns) {
            if (now - ts > 120_000) warnCooldowns.delete(ck);
            if (warnCooldowns.size <= MAX_GUILDS_TRACKED * 8) break;
        }
    }
    return true;
}

function checkRaidAlertCooldown(guildId, cooldownSeconds, now = Date.now()) {
    const last = raidAlerts.get(guildId) || 0;
    if (now - last < cooldownSeconds * 1000) return false;
    raidAlerts.set(guildId, now);
    return true;
}

function sweepExpired(now = Date.now()) {
    for (const [k, arr] of messageWindows) {
        pruneArray(arr, now - 120_000);
        if (arr.length === 0) messageWindows.delete(k);
    }
    for (const [k, arr] of duplicateHistory) {
        let i = 0;
        while (i < arr.length && arr[i].at < now - 120_000) i++;
        if (i > 0) arr.splice(0, i);
        if (arr.length === 0) duplicateHistory.delete(k);
    }
    for (const [k, arr] of joinWindows) {
        pruneArray(arr, now - 600_000);
        if (arr.length === 0) joinWindows.delete(k);
    }
    for (const [k, ts] of warnCooldowns) {
        if (now - ts > 300_000) warnCooldowns.delete(k);
    }
}

let sweepTimer = null;
function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweepExpired, 60_000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

module.exports = {
    recordMessage,
    recordDuplicate,
    recordJoin,
    checkWarnCooldown,
    checkRaidAlertCooldown,
    sweepExpired,
    startSweep,
    // Exposed for tests/diagnostics.
    _stores: { messageWindows, duplicateHistory, joinWindows, warnCooldowns, raidAlerts }
};
