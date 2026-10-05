// Pure per-rule check functions. Each returns { hit: boolean, detail: string }
// or null when the rule is disabled. No side effects, no I/O — safe to unit
// test. Link detection is reused from the existing Anti-Link module.

const { containsLink, stripCodeBlocks } = require('../../antilink/services/antiLinkService');

const INVITE_PATTERNS = [
    /discord\.gg\/[^\s<>()[\]{}"']+/i,
    /discord(?:app)?\.com\/invite\/[^\s<>()[\]{}"']+/i
];

const URL_STRIP = /https?:\/\/[^\s<>()[\]{}"']+/gi;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContent(content) {
    return String(content || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

function checkAntiLink(content) {
    if (!containsLink(content)) return null;
    return { hit: true, detail: 'Link detected' };
}

function checkAntiInvite(content) {
    const text = stripCodeBlocks(content);
    if (!text.trim()) return null;
    const match = INVITE_PATTERNS.some((pattern) => pattern.test(text));
    if (!match) return null;
    return { hit: true, detail: 'Discord invite detected' };
}

function checkAntiSpam(count, rule) {
    if (count >= (rule.maxMessages ?? 5)) {
        return { hit: true, detail: `${count} messages in ${rule.intervalSeconds ?? 5} seconds` };
    }
    return null;
}

function checkMassSpam(count, rule) {
    if (count >= (rule.maxMessages ?? 10)) {
        return { hit: true, detail: `${count} messages in ${rule.intervalSeconds ?? 10} seconds` };
    }
    return null;
}

function checkAntiDuplicate(dupCount, rule) {
    if (dupCount >= (rule.maxDuplicates ?? 3)) {
        return { hit: true, detail: `Same message sent ${dupCount} times in ${rule.intervalSeconds ?? 10} seconds` };
    }
    return null;
}

function checkAntiMentionSpam(message, rule) {
    const users = message.mentions?.users?.size ?? 0;
    const roles = message.mentions?.roles?.size ?? 0;
    const everyone = message.mentions?.everyone ? 1 : 0;
    const total = users + roles + everyone;
    if (total >= (rule.maxMentions ?? 5)) {
        return { hit: true, detail: `${total} mentions in one message (limit ${rule.maxMentions ?? 5})` };
    }
    return null;
}

function checkAntiEveryone(message) {
    if (!message.mentions?.everyone) return null;
    return { hit: true, detail: '@everyone/@here mention' };
}

function checkAntiCaps(content, rule) {
    const minLength = rule.minimumLength ?? 10;
    const threshold = rule.percentage ?? 70;
    // Ignore URLs and code blocks — they skew uppercase ratios.
    const text = stripCodeBlocks(content).replace(URL_STRIP, ' ').trim();
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length < minLength) return null;
    const upper = letters.replace(/[^A-Z]/g, '').length;
    const percentage = (upper / letters.length) * 100;
    if (percentage < threshold) return null;
    return { hit: true, detail: `Excessive caps (${Math.round(percentage)}% uppercase, minimum ${threshold}%)` };
}

function checkWordFilter(content, words) {
    if (!words || words.length === 0) return null;
    const text = stripCodeBlocks(content);
    for (const word of words) {
        const clean = String(word || '').trim().toLowerCase();
        if (!clean) continue;
        const pattern = new RegExp(`\\b${escapeRegExp(clean)}\\b`, 'i');
        if (pattern.test(text)) {
            return { hit: true, detail: 'Blocked word' };
        }
    }
    return null;
}

module.exports = {
    normalizeContent,
    checkAntiLink,
    checkAntiInvite,
    checkAntiSpam,
    checkMassSpam,
    checkAntiDuplicate,
    checkAntiMentionSpam,
    checkAntiEveryone,
    checkAntiCaps,
    checkWordFilter
};
