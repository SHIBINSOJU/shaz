const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const logger = require('../../../core/logger');

// Warn once per distinct problem so repeated welcomes don't spam the log.
const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
}

/**
 * Resolves the configured welcome GIF into something sendable:
 *  - source "url":   { url: <https url>, files: [] }
 *  - source "local": { url: "attachment://<name>", files: [AttachmentBuilder] }
 *  - disabled/missing/invalid: null (caller falls back to a GIF-less welcome)
 *
 * Never throws — a broken GIF configuration must not crash the bot.
 * Designed to be extended later (per-guild GIFs, PNGs, themes) by adding
 * new sources without changing the callers.
 */
function resolveWelcomeMedia(welcomeConfig) {
    const gif = welcomeConfig?.gif;
    if (!gif || gif.enabled === false) return null;

    const source = gif.source || (gif.url ? 'url' : gif.path ? 'local' : null);

    try {
        if (source === 'url') {
            if (!gif.url || !/^https?:\/\/\S+/i.test(gif.url)) {
                warnOnce('url', '⚠️ Welcome GIF is enabled with source "url" but no valid http(s) URL is configured. Sending welcome without GIF.');
                return null;
            }
            return { url: gif.url, files: [] };
        }

        if (source === 'local') {
            if (!gif.path) {
                warnOnce('path', '⚠️ Welcome GIF is enabled with source "local" but no path is configured. Sending welcome without GIF.');
                return null;
            }
            const resolved = path.isAbsolute(gif.path) ? gif.path : path.resolve(process.cwd(), gif.path);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                warnOnce(`missing:${resolved}`, `⚠️ Welcome GIF not found:\n${gif.path}`);
                return null;
            }
            const name = path.basename(resolved);
            return {
                url: `attachment://${name}`,
                files: [new AttachmentBuilder(resolved, { name })]
            };
        }

        warnOnce('source', '⚠️ Welcome GIF is enabled but source is neither "url" nor "local" (and no url/path given). Sending welcome without GIF.');
        return null;
    } catch (error) {
        warnOnce(`error:${error.message}`, `⚠️ Welcome GIF could not be loaded: ${error.message}. Sending welcome without GIF.`);
        return null;
    }
}

/**
 * Startup validation: returns { ok, message } describing the GIF config state
 * so the module can log it once during initialization.
 */
function validateWelcomeGif(welcomeConfig) {
    const gif = welcomeConfig?.gif;
    if (!gif) return { ok: true, message: 'No gif section configured.' };
    if (gif.enabled === false) return { ok: true, message: 'Welcome GIF disabled.' };

    const media = resolveWelcomeMedia(welcomeConfig);
    if (media) {
        return { ok: true, message: `Welcome GIF ready (${gif.source || 'auto'}: ${gif.source === 'local' ? gif.path : gif.url}).` };
    }
    return { ok: false, message: 'Welcome GIF enabled but unavailable — welcomes will be sent without it (see warning above).' };
}

module.exports = { resolveWelcomeMedia, validateWelcomeGif };
