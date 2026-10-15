// Per-user promotion cooldown (in-memory, per process).
// Duplicate-video protection is persistent (MongoDB via the repository with
// an in-memory fallback) and lives in videoPromotionRepository.js.

const cooldowns = new Map(); // `${guildId}:${userId}` -> timestamp (ms)

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

function prune(now = Date.now()) {
    if (cooldowns.size <= 1000) return;
    for (const [key, at] of cooldowns.entries()) {
        if (now - at > 3600 * 1000) cooldowns.delete(key);
        if (cooldowns.size <= 1000) break;
    }
}

/**
 * Returns { limited: false } when the user may promote, or
 * { limited: true, retryAfterSec } when they are still cooling down.
 * A non-positive cooldown disables the check.
 */
function checkCooldown(guildId, userId, cooldownSeconds) {
    if (!cooldownSeconds || cooldownSeconds <= 0) return { limited: false, retryAfterSec: 0 };
    const last = cooldowns.get(keyFor(guildId, userId)) || 0;
    const remainingMs = last + cooldownSeconds * 1000 - Date.now();
    if (remainingMs <= 0) return { limited: false, retryAfterSec: 0 };
    return { limited: true, retryAfterSec: Math.ceil(remainingMs / 1000) };
}

function setCooldown(guildId, userId) {
    prune();
    cooldowns.set(keyFor(guildId, userId), Date.now());
}

function clearCooldown(guildId, userId) {
    cooldowns.delete(keyFor(guildId, userId));
}

/** "300" -> "5m", "90" -> "1m 30s", "45" -> "45s" (user-safe display). */
function formatCooldown(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    if (minutes <= 0) return `${secs}s`;
    if (secs === 0) return `${minutes}m`;
    return `${minutes}m ${secs}s`;
}

module.exports = { checkCooldown, setCooldown, clearCooldown, formatCooldown };
