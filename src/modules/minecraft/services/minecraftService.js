const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const configService = require('../../../core/configService');

// ---------------------------------------------------------------------------
// Centralized Bedrock connection details — SINGLE source of truth.
// Bedrock is ALWAYS displayed as separate IP and Port fields, never as
// `host:port`. Every IP Container, DM, auto-response, log and status text
// must go through getBedrockConnection()/formatBedrockDetails() below so no
// hardcoded or inconsistent values can drift into different places.
// ---------------------------------------------------------------------------
const BEDROCK_DEFAULT_IP = 'risesmp.online';
const BEDROCK_DEFAULT_PORT = '25890';
const JAVA_DEFAULT_IP = 'risesmp.online';

// In-memory cooldown tracker: key `${channelId}:${userId}` -> timestamp (ms)
const lastTriggered = new Map();

// Recently processed Discord message IDs. discord.js can redeliver the same
// messageCreate after a reconnect/resume, and both deliveries pass the
// cooldown check — without this guard one `ip` message yields two DMs.
const seenMessages = new Map(); // messageId -> timestamp (ms)
const SEEN_TTL_MS = 120000;
const SEEN_MAX = 1000;

/**
 * Returns true if this message was already handled (duplicate delivery).
 * First call for an ID marks it seen and returns false.
 */
function alreadyProcessedMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    if (seenMessages.has(messageId)) return true;
    seenMessages.set(messageId, now);
    if (seenMessages.size > SEEN_MAX) {
        for (const [id, at] of seenMessages.entries()) {
            if (now - at > SEEN_TTL_MS) seenMessages.delete(id);
            if (seenMessages.size <= SEEN_MAX) break;
        }
    }
    return false;
}

// One private IP result per user: userId -> { appId, token, messageId, at }.
// Each button click would otherwise create a brand-new message; instead we
// edit the existing result in place through the interaction webhook, so each
// user ever sees exactly one.
const ephemeralResults = new Map();
const RESULT_TTL_MS = 14 * 60 * 1000; // interaction tokens live ~15 minutes
const RESULT_MAX = 500;

// Serializes concurrent button clicks from the same user so two rapid clicks
// can't both pass the "no result yet" check and each post a new message.
const resultLocks = new Map(); // userId -> Promise

function withIpResultLock(userId, fn) {
    const previous = resultLocks.get(userId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    const tracked = next.catch(() => {});
    resultLocks.set(userId, tracked);
    tracked.finally(() => {
        if (resultLocks.get(userId) === tracked) resultLocks.delete(userId);
    });
    return next;
}

function pruneResults(now = Date.now()) {
    for (const [userId, entry] of ephemeralResults.entries()) {
        if (now - entry.at > RESULT_TTL_MS) ephemeralResults.delete(userId);
    }
    if (ephemeralResults.size > RESULT_MAX) {
        const oldest = [...ephemeralResults.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [userId] of oldest.slice(0, ephemeralResults.size - RESULT_MAX)) {
            ephemeralResults.delete(userId);
        }
    }
}

function rememberEphemeralResult(userId, appId, token, messageId) {
    if (!userId || !token || !messageId) return;
    pruneResults();
    ephemeralResults.set(userId, { appId, token, messageId, at: Date.now() });
}

function clearEphemeralResult(userId) {
    ephemeralResults.delete(userId);
}

/**
 * Edits the user's existing private IP result via the original interaction
 * webhook. Returns true when the single result was updated (no new message),
 * false when there is nothing editable (caller should reply fresh instead).
 */
async function editEphemeralResult(userId, components) {
    const entry = ephemeralResults.get(userId);
    if (!entry) return false;
    if (Date.now() - entry.at > RESULT_TTL_MS) {
        ephemeralResults.delete(userId);
        return false;
    }
    try {
        const { WebhookClient } = require('discord.js');
        const webhook = new WebhookClient({ id: entry.appId, token: entry.token });
        try {
            // Partial edit keeps the message's existing flags (still ephemeral);
            // components are replaced wholesale with the new view.
            await webhook.editMessage(entry.messageId, { components });
        } finally {
            webhook.destroy();
        }
        entry.at = Date.now();
        return true;
    } catch {
        ephemeralResults.delete(userId);
        return false;
    }
}

function getMinecraftConfig() {
    const raw = configService.get('minecraft', {}) || {};
    const ipResp = raw.ipResponse || raw.ip_response || {};
    const java = ipResp.java || {};
    const bedrock = ipResp.bedrock || {};

    let accent = 0x5865F2;
    if (raw.accentColor) {
        const hex = String(raw.accentColor).replace(/^#/, '');
        const parsed = parseInt(hex, 16);
        if (!isNaN(parsed)) accent = parsed;
    }

    return {
        enabled: raw.enabled ?? true,
        serverName: raw.serverName || 'RISE SMP',
        accentColor: accent,
        ipResponse: {
            enabled: ipResp.enabled ?? true,
            cooldownSeconds: Number(ipResp.cooldownSeconds ?? ipResp.cooldown?.seconds ?? 5),
            java: {
                // Java is displayed as a bare host — no port is read or shown.
                address: String(java.address || JAVA_DEFAULT_IP).trim() || JAVA_DEFAULT_IP
            },
            bedrock: {
                // Centralized Bedrock defaults: IP risesmp.online, Port 25890.
                address: String(bedrock.address || BEDROCK_DEFAULT_IP).trim() || BEDROCK_DEFAULT_IP,
                port: bedrock.port !== undefined && bedrock.port !== null && String(bedrock.port).trim() !== ''
                    ? String(bedrock.port).trim()
                    : BEDROCK_DEFAULT_PORT
            }
        }
    };
}

/**
 * Per-channel / per-user cooldown so repeated keyword triggers cannot flood
 * the channel with prompts. Returns true when allowed.
 */
function checkCooldown(channelId, userId, cooldownSeconds) {
    const key = `${channelId}:${userId}`;
    const now = Date.now();
    const last = lastTriggered.get(key) || 0;
    const cooldownMs = (cooldownSeconds > 0 ? cooldownSeconds : 5) * 1000;

    if (now - last < cooldownMs) {
        return false;
    }

    lastTriggered.set(key, now);

    if (lastTriggered.size > 500) {
        for (const [k, time] of lastTriggered.entries()) {
            if (now - time > 60000) lastTriggered.delete(k);
        }
    }
    return true;
}

/**
 * Detects if a message is asking for or contains the Minecraft server IP.
 * Returns { matched: boolean, edition: 'all' | 'java' | 'bedrock' }
 */
function detectIpQuery(text) {
    if (!text || typeof text !== 'string') return { matched: false };
    const clean = text.toLowerCase().trim();

    if (clean.includes('risesmp.online')) {
        return { matched: true, edition: 'all' };
    }

    const javaPatterns = [
        /\bjava\s+(?:server\s+)?(?:ip|port|address)\b/i,
        /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?)?java\s+ip\??$/i,
        /\bjava\s+edition\s+(?:ip|port|address)\b/i,
        /\bip\s+(?:for\s+)?java\b/i
    ];
    if (javaPatterns.some(p => p.test(clean))) {
        return { matched: true, edition: 'java' };
    }

    const bedrockPatterns = [
        /\b(?:bedrock|pocket\s+edition|pe|mobile)\s+(?:server\s+)?(?:ip|port|address)\b/i,
        /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?)?bedrock\s+ip\??$/i,
        /\bbedrock\s+edition\s+(?:ip|port|address)\b/i,
        /\bip\s+(?:for\s+)?bedrock\b/i,
        /\bbedrock\s+port\b/i
    ];
    if (bedrockPatterns.some(p => p.test(clean))) {
        return { matched: true, edition: 'bedrock' };
    }

    const generalPatterns = [
        /\b(?:server|minecraft|mc)\s+ip\b/i,
        /\bip\s+(?:of\s+the\s+server|for\s+the\s+server|to\s+join)\b/i,
        /\b(?:what(?:'s|\s+is)?|drop|give|send|tell\s+me)\s+(?:the\s+)?(?:server\s+)?(?:ip|address)\b/i,
        /\bhow\s+(?:to|do\s+i|can\s+i)\s+join\b/i,
        /\bserver\s+address\b/i,
        /^(?:what(?:'s|\s+is)?\s+)?ip\??$/i,
        /^(?:server\s*)?ip\??$/i
    ];
    if (generalPatterns.some(p => p.test(clean))) {
        return { matched: true, edition: 'all' };
    }

    return { matched: false };
}

/** Java is always shown as a bare host — never with a port. */
function formatJavaAddress(config) {
    return config.ipResponse.java.address;
}

/**
 * Centralized Bedrock connection resolver.
 * Accepts a normalized minecraft config (with `ipResponse.bedrock`) or nothing
 * (then the current config is loaded). Always returns { ip, port } strings.
 * Single source of truth — no caller may hardcode the Bedrock host/port.
 */
function getBedrockConnection(config) {
    const cfg = config || getMinecraftConfig();
    const bedrock = (cfg && cfg.ipResponse && cfg.ipResponse.bedrock) || {};
    const ip = String(bedrock.address || BEDROCK_DEFAULT_IP).trim() || BEDROCK_DEFAULT_IP;
    const port = bedrock.port !== undefined && bedrock.port !== null && String(bedrock.port).trim() !== ''
        ? String(bedrock.port).trim()
        : BEDROCK_DEFAULT_PORT;
    return { ip, port };
}

/**
 * Display-ready Bedrock details with SEPARATE IP and Port fields.
 * Used inside Components V2 TextDisplays. Never returns `host:port`.
 * Renders as:
 *   IP: `risesmp.online`
 *   Port: `25890`
 */
function formatBedrockDetails(config) {
    const { ip, port } = getBedrockConnection(config);
    return `IP: \`${ip}\`\nPort: \`${port}\``;
}

/**
 * Historic formatter name — now an alias to formatBedrockDetails so every
 * existing caller automatically gets separate IP/Port fields.
 * NEVER returns `host:port`.
 */
function formatBedrockAddress(config) {
    return formatBedrockDetails(config);
}

/**
 * Generic single-line host/port display for logs / status text (no Discord
 * code ticks): `IP: risesmp.online | Port: 25890`. Never `host:port`.
 * This is the ONE centralized formatter — query diagnostics, monitor logs
 * and status text must all go through it (or sanitizeAddressForLog below).
 */
function formatHostPortLog(host, port) {
    const ip = String(host).trim() || BEDROCK_DEFAULT_IP;
    const cleanPort = port !== undefined && port !== null && String(port).trim() !== ''
        ? String(port).trim()
        : BEDROCK_DEFAULT_PORT;
    return `IP: ${ip} | Port: ${cleanPort}`;
}

/**
 * Single-line Bedrock display for logs / status text (no Discord code ticks):
 * `IP: risesmp.online | Port: 25890`. Never `host:port`.
 */
function formatBedrockLogString(configOrHost, maybePort) {
    if (typeof configOrHost === 'string') {
        return formatHostPortLog(configOrHost, maybePort);
    }
    const { ip, port } = getBedrockConnection(configOrHost);
    return formatHostPortLog(ip, port);
}

/**
 * Rewrites any residual `hostname:port` / `IPv4:port` fragments inside free
 * text (e.g. Node socket errors like `connect ECONNREFUSED 1.2.3.4:25890`)
 * into the separate `IP: … | Port: …` form so logs never show a combined
 * address. Leaves text without such fragments untouched.
 */
function sanitizeAddressForLog(text) {
    if (text === undefined || text === null) return text;
    let out = String(text);
    // IPv4 literals first: 1.2.3.4:25890
    out = out.replace(/(\b\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g, 'IP: $1 | Port: $2');
    // DNS hostnames: <hostname>:<port> (requires a dotted name so clock
    // strings like 07:07:55 and stage labels are never touched).
    out = out.replace(/(^|[\s>(;[])([A-Za-z0-9](?:[A-Za-z0-9.-]{0,200}[A-Za-z0-9])?\.[A-Za-z]{2,}):(\d{2,5})(?![\w:])/g, '$1IP: $2 | Port: $3');
    return out;
}

/** [☕ Java IP] [🪨 Bedrock IP] [🎮 Both] — the active edition is highlighted. */
function buildIpRow(edition) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mc:ip:java')
            .setLabel('☕ Java IP')
            .setStyle(edition === 'java' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mc:ip:bedrock')
            .setLabel('🪨 Bedrock IP')
            .setStyle(edition === 'bedrock' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mc:ip:all')
            .setLabel('🎮 Both')
            .setStyle(edition === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
}

// Every IP payload is private: Components V2 + Ephemeral + zero mentions, so
// the address is only ever rendered for the member who asked for it.
const PRIVATE_IP_FLAGS = [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral];
const NO_MENTIONS = { parse: [], repliedUser: false };

/**
 * Builds the ephemeral Components V2 container with the server addresses.
 * Used by /serverip and by every `mc:ip:*` button — never posted publicly.
 */
function buildIpResponse(config, edition = 'all') {
    const javaDisplay = formatJavaAddress(config);
    const bedrockDetails = formatBedrockDetails(config);

    const container = new ContainerBuilder().setAccentColor(config.accentColor);
    const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎮 ${config.serverName}`));

    if (edition === 'bedrock') {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### 🪨 BEDROCK EDITION\n\n${bedrockDetails}`
        ));
    } else {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### ☕ JAVA EDITION\n\n\`${javaDisplay}\``
        ));
        if (edition !== 'java') {
            container.addSeparatorComponents(divider());
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `### 🪨 BEDROCK EDITION\n\n${bedrockDetails}`
            ));
        }
    }

    container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '-# 🔒 Private view — only you can see this message.'
    ));

    return {
        flags: PRIVATE_IP_FLAGS,
        components: [container, buildIpRow(edition)],
        allowedMentions: NO_MENTIONS
    };
}

/**
 * The DM version of the IP panel. Same single Components V2 builder as the
 * ephemeral reply — only the Ephemeral flag is dropped, because a bot-token
 * channel/DM send cannot carry it and a DM is private by nature.
 */
function buildIpDirectMessage(config, edition = 'all') {
    const payload = buildIpResponse(config, edition);
    return { ...payload, flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
    getMinecraftConfig,
    checkCooldown,
    detectIpQuery,
    formatJavaAddress,
    getBedrockConnection,
    formatBedrockDetails,
    formatBedrockAddress,
    formatBedrockLogString,
    formatHostPortLog,
    sanitizeAddressForLog,
    buildIpResponse,
    buildIpDirectMessage,
    alreadyProcessedMessage,
    withIpResultLock,
    rememberEphemeralResult,
    clearEphemeralResult,
    editEphemeralResult,
    BEDROCK_DEFAULT_IP,
    BEDROCK_DEFAULT_PORT,
    JAVA_DEFAULT_IP
};
