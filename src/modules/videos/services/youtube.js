// YouTube URL validation, normalization, and metadata retrieval.
//
// Metadata strategy (never invents titles — every field is either verified
// or omitted):
//   1. YouTube Data API v3 when an API key is configured (verifies live status).
//   2. Free oEmbed endpoint when no key is available (title + author only,
//      live status stays "unknown" and is NEVER presented as verified).
//   3. Bare fallback (video ID + standard thumbnail URL) when both fail.

const logger = require('../../../core/logger');

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Hosts that genuinely belong to YouTube. Anything else is rejected, so
// lookalike domains (e.g. youtube.evil.com) can never pass validation.
const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com'
]);

const FETCH_TIMEOUT_MS = 8000;

function isValidVideoId(value) {
    return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

/**
 * Parses and validates a user-supplied URL.
 * Returns { ok: true, videoId, url } with a normalized watch URL, or
 * { ok: false, reason } with a user-safe rejection message.
 */
function parseYouTubeUrl(input) {
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return { ok: false, reason: 'Please provide a YouTube link.' };
    }

    let parsed;
    try {
        parsed = new URL(input.trim());
    } catch {
        return { ok: false, reason: '❌ That is not a valid URL. Please provide a YouTube video or livestream link.' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: '❌ Only http(s) YouTube links are accepted.' };
    }

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) {
        return { ok: false, reason: '❌ Only YouTube links are accepted (youtube.com, youtu.be, youtube-nocookie.com).' };
    }

    let videoId = null;
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' || host === 'www.youtu.be') {
        // https://youtu.be/VIDEO_ID
        videoId = segments[0] || null;
    } else if (parsed.pathname === '/watch') {
        // https://www.youtube.com/watch?v=VIDEO_ID
        videoId = parsed.searchParams.get('v');
    } else if (segments.length >= 2 && ['live', 'shorts', 'embed', 'v'].includes(segments[0])) {
        // https://www.youtube.com/live/VIDEO_ID (also /shorts/, /embed/, /v/)
        videoId = segments[1];
    }

    if (!videoId || !isValidVideoId(videoId)) {
        return { ok: false, reason: '❌ Could not find a valid YouTube video ID in that link. Please check the URL and try again.' };
    }

    return { ok: true, videoId, url: normalizeWatchUrl(videoId) };
}

/** Canonical form every promotion links to: https://www.youtube.com/watch?v=ID */
function normalizeWatchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Official YouTube Data API v3 lookup. Returns null when the key is missing,
 * the request fails, or the video is not found — never throws for metadata.
 * This is the ONLY path that can confirm a stream is actually live.
 */
async function fetchViaDataApi(videoId, apiKey) {
    if (!apiKey) return null;
    try {
        const endpoint = `https://www.googleapis.com/youtube/v3/videos`
            + `?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}`
            + `&key=${encodeURIComponent(apiKey)}`;
        const data = await fetchJson(endpoint);
        const item = data?.items?.[0];
        if (!item) {
            logger.warn(`YouTube Data API returned no video for ID ending ...${videoId.slice(-4)} (private, deleted, or invalid).`);
            return null;
        }
        const snippet = item.snippet || {};
        const liveContent = snippet.liveBroadcastContent || 'none';
        return {
            title: snippet.title || null,
            channelTitle: snippet.channelTitle || null,
            publishedAt: snippet.publishedAt || null,
            liveStatus: liveContent === 'live' ? 'live' : liveContent === 'upcoming' ? 'upcoming' : 'none',
            verifiedLive: liveContent === 'live',
            source: 'api'
        };
    } catch (error) {
        // API key is never logged; metadata failure falls through to oEmbed.
        logger.warn(`YouTube Data API lookup failed, falling back to oEmbed: ${error?.message || error}`);
        return null;
    }
}

/**
 * Free oEmbed lookup (no key required). Provides title + author only.
 * Live status is always "unknown" here — callers must never present it
 * as verified.
 */
async function fetchViaOEmbed(normalizedUrl) {
    try {
        const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`;
        const data = await fetchJson(endpoint);
        if (!data?.title) return null;
        return {
            title: data.title,
            channelTitle: data.author_name || null,
            publishedAt: null,
            liveStatus: 'unknown',
            verifiedLive: false,
            source: 'oembed'
        };
    } catch (error) {
        logger.warn(`YouTube oEmbed lookup failed, using ID-only fallback: ${error?.message || error}`);
        return null;
    }
}

/**
 * Best-effort reachability probe for the custom promotional banner.
 * Returns true when the URL answers HTTP 2xx, false otherwise — never
 * throws. A `false` result must only produce a loud log warning: the caller
 * publishes anyway and must NEVER substitute the YouTube thumbnail.
 */
async function checkImageReachable(url, timeoutMs = 5000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
            return response.ok;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return false;
    }
}

/**
 * Best-effort metadata. Always resolves (never rejects): when every source
 * fails the caller still gets { source: 'none' } and promotes with the
 * custom banner + video link instead of invented data.
 */
async function fetchVideoMetadata(videoId, normalizedUrl, apiKey) {
    const viaApi = await fetchViaDataApi(videoId, apiKey);
    if (viaApi) return viaApi;
    const viaOEmbed = await fetchViaOEmbed(normalizedUrl);
    if (viaOEmbed) return viaOEmbed;
    return {
        title: null,
        channelTitle: null,
        publishedAt: null,
        liveStatus: 'unknown',
        verifiedLive: false,
        source: 'none'
    };
}

module.exports = {
    parseYouTubeUrl,
    normalizeWatchUrl,
    fetchVideoMetadata,
    isValidVideoId,
    checkImageReachable
};
