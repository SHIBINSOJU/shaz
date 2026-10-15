// Shared RISE NETWORK branding — single source of truth for the bot's
// embed / Components V2 container accent color.
//
// Canonical value: RISE red #E53935 (decimal 15022645). Manage it centrally
// via `branding.accentColor` in src/config/config.yml; this module parses it
// once at startup. Every bot-generated layout imports BRAND_RED (or calls
// getBrandColor()) instead of hardcoding its own hex.
//
// Semantic colors (success green, error red, neutral grey) and user/role
// derived colors are NOT branding and must stay untouched.

const configService = require('../core/configService');

const FALLBACK_RED = 0xE53935;
const BRAND_RED_HEX = '#E53935';

function parseHexColor(raw) {
    if (typeof raw !== 'string') return null;
    const match = raw.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) return null;
    return parseInt(match[1], 16);
}

function resolveBrandColor() {
    try {
        const configured = configService.get('branding.accentColor', BRAND_RED_HEX);
        return parseHexColor(configured) ?? FALLBACK_RED;
    } catch {
        return FALLBACK_RED;
    }
}

const BRAND_RED = resolveBrandColor();

function getBrandColor() {
    return BRAND_RED;
}

module.exports = { BRAND_RED, BRAND_RED_HEX, getBrandColor };
