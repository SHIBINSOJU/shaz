const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Parses durations like "30s", "15m", "2h", "7d" into milliseconds.
// Returns null when invalid or out of range.
function parseDuration(input) {
    if (!input) return null;
    const match = String(input).trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    const ms = amount * multipliers[match[2]];
    if (ms > MAX_MS) return null;
    return ms;
}

function describeDuration(ms) {
    const total = Math.floor(ms / 1000);
    if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
    if (total < 3600) {
        const m = Math.floor(total / 60);
        return `${m} minute${m === 1 ? '' : 's'}`;
    }
    if (total < 86400) {
        const h = Math.floor(total / 3600);
        return `${h} hour${h === 1 ? '' : 's'}`;
    }
    const d = Math.floor(total / 86400);
    return `${d} day${d === 1 ? '' : 's'}`;
}

module.exports = { parseDuration, describeDuration, MAX_MS };
