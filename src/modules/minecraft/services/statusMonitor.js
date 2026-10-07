const fs = require('fs');
const path = require('path');
const logger = require('../../../core/logger');
const configService = require('../../../core/configService');
const { getMinecraftConfig, BEDROCK_DEFAULT_IP, BEDROCK_DEFAULT_PORT, JAVA_DEFAULT_IP, formatBedrockLogString, formatHostPortLog, sanitizeAddressForLog } = require('./minecraftService');
const { safeQueryJava, safeQueryBedrock } = require('./minecraftQuery');
const statusRepository = require('../../../database/repositories/minecraftStatusRepository');
const { isDatabaseReady } = require('../../../database/connection');

// ---------------------------------------------------------------------------
// Single-server status monitor for the ONE config-defined RISE SMP server
// (default IP: risesmp.online / Port: 25890). Java + Bedrock query results are
// MERGED into one combined status — never separate sections.
//
// - Polls on updateInterval, detects online<->offline transitions, tracks
//   DETECTED continuous uptime (now - onlineSince, not exact server boot).
// - Persists onlineSince/message refs to MongoDB AND a local JSON fallback so
//   a bot restart never resets Minecraft uptime.
// - Keeps exactly ONE permanent public status message in the configured
//   channel: creates it once, then edits the same message on every refresh.
//
// Anti-spam guarantees:
//  - Exactly ONE Java + ONE Bedrock query per poll cycle (same host + port).
//  - Polls never overlap (a slow cycle is skipped, not stacked).
//  - Manual refreshes are rate-limited to `minRefreshMs`.
//  - The Discord side (/mcstatus) reads the cache; it never queries on demand
//    except through the guarded refresh path.
// ---------------------------------------------------------------------------

let timer = null;
let started = false;
let hydrated = false;
let hydratePromise = null;
let polling = false;
let publishing = false;
let lastQueryAt = 0;
let warnedNoDb = false;
let warnedNoChannel = false;
let discordClient = null;
// Favicon data URL last attached to the permanent message. Compared on every
// publish so a changed server icon is re-uploaded; otherwise the existing
// attachment is reused and edits never pile PNGs onto the message.
let lastPublishedFavicon = null;

const FAVICON_ATTACHMENT_NAME = 'server-favicon.png';

const FILE_STATE_PATH = path.join(process.cwd(), 'data', 'minecraft-status.json');

function blankEdition() {
    return {
        online: false,
        onlineSince: null,
        lastOnlineChange: null,
        lastChecked: null,
        players: { online: 0, max: 0, names: [] },
        version: null,
        protocol: null,
        ping: null,
        favicon: null,
        error: null
    };
}

const state = {
    java: blankEdition(),
    bedrock: blankEdition(),
    server: { online: false, onlineSince: null, lastOnlineChange: null, lastChecked: null },
    favicon: null,
    statusMessageId: null,
    statusChannelId: null,
    lastPollAt: 0
};

/**
 * Effective status configuration for the SINGLE combined server.
 * New keys: status.channelId, status.updateInterval, status.host, status.port.
 * Deprecated aliases still honoured: status.pollSeconds (-> updateInterval),
 * status.javaPort (-> port). Nothing is hardcoded that config can provide.
 */
function getStatusConfig() {
    const base = getMinecraftConfig();
    const raw = configService.get('minecraft', {}) || {};
    const st = raw.status || {};

    const host = String(st.host || base.ipResponse.java.address || JAVA_DEFAULT_IP).trim() || JAVA_DEFAULT_IP;
    let port = Number(st.port);
    if (!(port > 0)) port = Number(st.javaPort);
    if (!(port > 0)) port = Number(base.ipResponse.bedrock.port);
    if (!(port > 0)) port = Number(BEDROCK_DEFAULT_PORT);

    // updateInterval (seconds) wins; pollSeconds is the deprecated alias.
    const intervalSec = Number(st.updateInterval) > 0 ? Number(st.updateInterval)
        : (Number(st.pollSeconds) > 0 ? Number(st.pollSeconds) : 60);

    // Bedrock-safe display: ALWAYS separate IP and Port fields, never host:port.
    // `host`/`port` stay numeric for the actual socket queries; `display` is
    // the human/log/status string built through the centralized formatter.
    const display = formatBedrockLogString(host, port);

    return {
        enabled: base.enabled !== false && st.enabled !== false,
        serverName: base.serverName || 'RISE SMP',
        accentColor: base.accentColor,
        host,
        port,
        display,
        channelId: String(st.channelId || '').trim(),
        pollMs: Math.max(15, intervalSec) * 1000,
        updateInterval: Math.max(15, intervalSec),
        timeoutMs: Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : 5000,
        minRefreshMs: Math.max(5, Number(st.minRefreshSeconds) > 0 ? Number(st.minRefreshSeconds) : 15) * 1000
    };
}

function applyResult(editionKey, result, at) {
    const s = state[editionKey];
    s.lastChecked = new Date(at);

    if (result && result.online) {
        if (!s.online) {
            s.onlineSince = new Date(at);
            s.lastOnlineChange = new Date(at);
        }
        s.online = true;
        s.players = {
            online: Number(result.players?.online) || 0,
            max: Number(result.players?.max) || 0,
            names: Array.isArray(result.players?.names) ? result.players.names.slice(0, 50) : []
        };
        s.version = result.version ?? null;
        s.protocol = Number(result.protocol) || null;
        s.ping = typeof result.ping === 'number' ? Math.round(result.ping) : null;
        s.favicon = typeof result.favicon === 'string' ? result.favicon : s.favicon;
        if (editionKey === 'java' && s.favicon) state.favicon = s.favicon;
        s.error = null;
    } else {
        if (s.online) {
            s.onlineSince = null;
            s.lastOnlineChange = new Date(at);
        }
        s.online = false;
        s.players = { online: 0, max: s.players?.max ?? 0, names: [] };
        s.version = null;
        s.protocol = null;
        s.ping = null;
        // Keep the last known favicon so the thumbnail survives short outages.
        s.error = result?.error || 'offline';
    }
}

function applyServer(at) {
    const online = state.java.online || state.bedrock.online;
    const srv = state.server;
    if (online && !srv.online) {
        // Server came back after being offline: detected uptime restarts HERE.
        srv.onlineSince = new Date(at);
        srv.lastOnlineChange = new Date(at);
    } else if (!online && srv.online) {
        srv.onlineSince = null;
        srv.lastOnlineChange = new Date(at);
    }
    srv.online = online;
    srv.lastChecked = new Date(at);
}

function uptimeMs(now = Date.now()) {
    const since = state.server.onlineSince;
    return since ? Math.max(0, now - since.getTime()) : 0;
}

// -- persistence (MongoDB + local file fallback) -----------------------------

function flatten(s) {
    return {
        online: s.online,
        onlineSince: s.onlineSince,
        lastOnlineChange: s.lastOnlineChange,
        lastChecked: s.lastChecked,
        playersOnline: s.players.online,
        playersMax: s.players.max,
        playerNames: s.players.names,
        version: s.version,
        protocol: s.protocol,
        ping: s.ping,
        error: s.error
    };
}

function unflattenEdition(doc) {
    const s = blankEdition();
    if (!doc) return s;
    s.online = Boolean(doc.online);
    s.onlineSince = doc.onlineSince ? new Date(doc.onlineSince) : null;
    s.lastOnlineChange = doc.lastOnlineChange ? new Date(doc.lastOnlineChange) : null;
    s.lastChecked = doc.lastChecked ? new Date(doc.lastChecked) : null;
    s.players = {
        online: Number(doc.playersOnline) || 0,
        max: Number(doc.playersMax) || 0,
        names: Array.isArray(doc.playerNames) ? doc.playerNames : []
    };
    s.version = doc.version ?? null;
    s.protocol = doc.protocol != null ? Number(doc.protocol) : null;
    s.ping = doc.ping != null ? Number(doc.ping) : null;
    s.error = doc.error ?? null;
    return s;
}

function saveFileState() {
    try {
        fs.mkdirSync(path.dirname(FILE_STATE_PATH), { recursive: true });
        fs.writeFileSync(FILE_STATE_PATH, JSON.stringify({
            server: {
                online: state.server.online,
                onlineSince: state.server.onlineSince,
                lastOnlineChange: state.server.lastOnlineChange,
                lastChecked: state.server.lastChecked
            },
            java: flatten(state.java),
            bedrock: flatten(state.bedrock),
            favicon: state.favicon,
            statusMessageId: state.statusMessageId,
            statusChannelId: state.statusChannelId,
            savedAt: new Date().toISOString()
        }), 'utf8');
    } catch (error) {
        logger.warn(`Minecraft status: could not write fallback state file (${error.message}).`);
    }
}

function loadFileState() {
    try {
        if (!fs.existsSync(FILE_STATE_PATH)) return null;
        return JSON.parse(fs.readFileSync(FILE_STATE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

async function persist() {
    // Local file is ALWAYS written so uptime + message id survive a restart
    // even when MongoDB is unavailable.
    saveFileState();
    if (!isDatabaseReady()) {
        if (!warnedNoDb) {
            warnedNoDb = true;
            logger.warn('Minecraft status: database unavailable — using local file fallback for uptime persistence.');
        }
        return;
    }
    const doc = {
        java: flatten(state.java),
        bedrock: flatten(state.bedrock),
        server: {
            online: state.server.online,
            onlineSince: state.server.onlineSince,
            lastOnlineChange: state.server.lastOnlineChange,
            lastChecked: state.server.lastChecked
        },
        statusMessageId: state.statusMessageId,
        statusChannelId: state.statusChannelId,
        favicon: state.favicon
    };
    await statusRepository.saveStatus(doc);
}

function applyPersistedDoc(doc) {
    if (!doc) return false;
    state.java = unflattenEdition(doc.java);
    state.bedrock = unflattenEdition(doc.bedrock);
    if (doc.server) {
        state.server.online = Boolean(doc.server.online);
        state.server.onlineSince = doc.server.onlineSince ? new Date(doc.server.onlineSince) : null;
        state.server.lastOnlineChange = doc.server.lastOnlineChange ? new Date(doc.server.lastOnlineChange) : null;
        state.server.lastChecked = doc.server.lastChecked ? new Date(doc.server.lastChecked) : null;
    }
    if (doc.statusMessageId) state.statusMessageId = String(doc.statusMessageId);
    if (doc.statusChannelId) state.statusChannelId = String(doc.statusChannelId);
    if (typeof doc.favicon === 'string' && doc.favicon.startsWith('data:image/')) state.favicon = doc.favicon;
    return true;
}

async function hydrate() {
    const doc = await statusRepository.loadStatus();    if (doc && (doc.server || doc.java || doc.bedrock)) {
        applyPersistedDoc(doc);
        // File fallback stays in sync for next time.
        saveFileState();
        logger.info('Minecraft status: restored persisted uptime/last-online state from database.');
        return;
    }
    const fileDoc = loadFileState();
    if (fileDoc) {
        applyPersistedDoc(fileDoc);
        logger.info('Minecraft status: restored uptime/message state from local fallback file.');
    }
    hydrated = true;
}

// Guarantees persisted uptime is loaded before the first poll of this process,
// even if poll()/refresh() runs before start() finishes. Single-flight: racing
// callers share one hydrate instead of each restoring separately.
async function ensureHydrated() {
    if (hydrated) return;
    if (!hydratePromise) {
        hydratePromise = hydrate().then(() => { hydrated = true; });
    }
    await hydratePromise;
}

// -- combined single-server snapshot -----------------------------------------

/** Merges the two edition query results into ONE server status. */
function getSnapshot() {
    const cfg = getStatusConfig();
    const now = Date.now();
    const javaOn = state.java.online;
    const bedrockOn = state.bedrock.online;
    const online = state.server.online;

    // Java's player list already includes Bedrock (Geyser) players, so Java is
    // primary — never sum the two counts (that would double-count).
    const primary = javaOn ? state.java : (bedrockOn ? state.bedrock : state.java);
    const players = {
        online: online ? (Number(primary.players?.online) || 0) : 0,
        max: Number(primary.players?.max) || Number(state.java.players?.max) || Number(state.bedrock.players?.max) || 0,
        names: online ? [...(state.java.players?.names || [])] : []
    };
    const pings = [state.java.ping, state.bedrock.ping].filter((p) => typeof p === 'number');
    return {
        serverName: cfg.serverName,
        accentColor: cfg.accentColor,
        host: cfg.host,
        port: cfg.port,
        display: cfg.display,
        online,
        players,
        version: (javaOn ? state.java.version : null) ?? (bedrockOn ? state.bedrock.version : null) ?? null,
        ping: pings.length ? Math.min(...pings) : null,
        favicon: state.favicon,
        // Detected uptime: time since THIS bot first saw the server online.
        // Not the exact server boot time — labelled as such in the view.
        uptimeMs: uptimeMs(now),
        onlineSince: state.server.onlineSince,
        lastChecked: state.lastPollAt ? new Date(state.lastPollAt) : (state.server.lastChecked || null),
        lastOnlineChange: state.server.lastOnlineChange,
        // Raw edition results kept for debugging; the view must NOT render
        // separate Java/Bedrock sections.
        java: {
            online: state.java.online,
            players: { ...state.java.players },
            version: state.java.version,
            ping: state.java.ping,
            error: state.java.error
        },
        bedrock: {
            online: state.bedrock.online,
            players: { ...state.bedrock.players },
            version: state.bedrock.version,
            ping: state.bedrock.ping,
            error: state.bedrock.error
        }
    };
}

// -- permanent ONE-message publishing ---------------------------------------

function setClient(client) {
    if (client) discordClient = client;
}

/** True when a (possibly nested) component tree contains our status buttons. */
function hasStatusButton(component) {
    if (!component) return false;
    if (component.customId === 'mc:status:refresh' || component.customId === 'mc:status:players') return true;
    const kids = component.components || [];
    return Array.isArray(kids) && kids.some(hasStatusButton);
}

/** Finds our permanent status message among recent bot messages (DB-loss recovery). */
async function findExistingStatusMessage(channel, botId) {
    try {
        const recent = await channel.messages.fetch({ limit: 25 });
        for (const msg of recent.values()) {
            if (msg.author?.id !== botId) continue;
            // Buttons live INSIDE the status Container, so search recursively.
            if ((msg.components || []).some(hasStatusButton)) return msg;
        }
    } catch {
        // History not readable — caller falls back to send-new.
    }
    return null;
}

/**
 * Decides which favicon files/attachments an edit of the permanent message
 * should carry, given what the message already has:
 *  - icon changed since last publish -> prune stale copies (retain-list) and
 *    upload the fresh icon;
 *  - message already carries the current icon -> upload nothing (no pile-up);
 *  - otherwise -> upload the fresh icon once.
 * Returns { files, attachments } where attachments===undefined means "leave
 * existing attachments alone".
 */
function faviconEditPlan(message, payloadFiles, snapshot) {
    const current = typeof snapshot?.favicon === 'string' && snapshot.favicon ? snapshot.favicon : null;
    if (!current) return { files: [], attachments: undefined };
    try {
        const atts = [...(message?.attachments?.values?.() || [])];
        const hasFavicon = atts.some((a) => a?.name === FAVICON_ATTACHMENT_NAME);
        if (lastPublishedFavicon && lastPublishedFavicon !== current) {
            const keep = atts.filter((a) => a?.name !== FAVICON_ATTACHMENT_NAME).map((a) => ({ id: a.id }));
            return { files: payloadFiles, attachments: keep };
        }
        if (hasFavicon) return { files: [], attachments: undefined };
        return { files: payloadFiles, attachments: undefined };
    } catch {
        return { files: [], attachments: undefined };
    }
}

async function publish() {
    if (publishing) return getSnapshot();
    const cfg = getStatusConfig();
    if (!cfg.enabled || !cfg.channelId) {
        if (!warnedNoChannel) {
            warnedNoChannel = true;
            logger.info('Minecraft status: no status.channelId configured — permanent message disabled (polling + /mcstatus still work).');
        }
        return getSnapshot();
    }
    if (!discordClient) return getSnapshot();
    publishing = true;
    try {
        // Lazy import avoids a require cycle (statusView never requires monitor).
        const { buildStatusResponse } = require('./statusView');
        const snapshot = getSnapshot();
        const payload = buildStatusResponse(snapshot);

        let channel;
        try {
            channel = await discordClient.channels.fetch(cfg.channelId);
        } catch (error) {
            logger.warn(`Minecraft status: cannot access status channel ${cfg.channelId} (${error.message}).`);
            return snapshot;
        }
        if (!channel || typeof channel.send !== 'function') {
            logger.warn(`Minecraft status: status channel ${cfg.channelId} is not a text channel.`);
            return snapshot;
        }

        const messageData = { components: payload.components, files: payload.files || [], flags: payload.flags, allowedMentions: payload.allowedMentions };

        // 1) Edit the stored message.
        const storedId = state.statusMessageId || (await statusRepository.loadStatus())?.statusMessageId;
        if (storedId) {
            try {
                const existing = await channel.messages.fetch(String(storedId));
                if (existing) {
                    // Reuses the existing favicon attachment (or re-uploads on
                    // icon change) so edits never pile PNGs onto the message.
                    const plan = faviconEditPlan(existing, payload.files || [], snapshot);
                    const edit = { ...messageData, files: plan.files };
                    if (plan.attachments !== undefined) edit.attachments = plan.attachments;
                    await existing.edit(edit);
                    state.statusMessageId = existing.id;
                    state.statusChannelId = channel.id;
                    lastPublishedFavicon = typeof snapshot.favicon === 'string' ? snapshot.favicon : null;
                    await persist();
                    return snapshot;
                }
            } catch {
                // Stored message gone (deleted) — fall through to recovery.
                state.statusMessageId = null;
            }
        }

        // 2) Adopt an existing bot status message from history (no duplicates).
        const adopted = await findExistingStatusMessage(channel, discordClient.user?.id);
        if (adopted) {
            try {
                const plan = faviconEditPlan(adopted, payload.files || [], snapshot);
                const edit = { ...messageData, files: plan.files };
                if (plan.attachments !== undefined) edit.attachments = plan.attachments;
                await adopted.edit(edit);
                state.statusMessageId = adopted.id;
                state.statusChannelId = channel.id;
                lastPublishedFavicon = typeof snapshot.favicon === 'string' ? snapshot.favicon : null;
                await persist();
                logger.info(`Minecraft status: adopted existing status message ${adopted.id} (no duplicate posted).`);
                return snapshot;
            } catch (error) {
                logger.warn(`Minecraft status: could not edit adopted message (${error.message}).`);
            }
        }

        // 3) Send the single permanent message for the first time.
        const sent = await channel.send(messageData);
        state.statusMessageId = sent.id;
        state.statusChannelId = channel.id;
        lastPublishedFavicon = typeof snapshot.favicon === 'string' ? snapshot.favicon : null;
        await persist();
        logger.info(`Minecraft status: created permanent status message ${sent.id} in #${channel.name || cfg.channelId}.`);
        return snapshot;
    } catch (error) {
        logger.warn(`Minecraft status: permanent message update failed (${error.message}).`);
        return getSnapshot();
    } finally {
        publishing = false;
    }
}

/** One poll cycle. Never throws; returns the fresh combined snapshot. */
async function poll(reason = 'interval') {
    const cfg = getStatusConfig();
    if (!cfg.enabled) return getSnapshot();
    if (polling) return getSnapshot(); // previous cycle still running — skip, don't stack

    polling = true;
    lastQueryAt = Date.now();
    logger.info(`[MC STATUS] Checking ${cfg.display} (${reason})`);
    try {
        await ensureHydrated();
        const [java, bedrock] = await Promise.all([
            safeQueryJava(cfg.host, cfg.port, cfg.timeoutMs),
            safeQueryBedrock(cfg.host, cfg.port, cfg.timeoutMs)
        ]);
        const at = Date.now();
        applyResult('java', java, at);
        applyResult('bedrock', bedrock, at);
        applyServer(at);
        state.lastPollAt = at;
        await persist();
        // REAL outcome with REAL errors — never a bare "offline" and never a
        // forced ONLINE. `online` flips only when an edition query actually
        // responds. The `error` strings carry IP + Port + stage (tcp-connect vs
        // status-read) + elapsed + timeout, so logs show WHY the server is
        // unreachable (DNS/SRV? firewall? Pterodactyl allocation down? MC
        // process not answering Server List Ping?). sanitizeAddressForLog is
        // belt-and-braces: query modules already emit the separate form, but
        // raw Node/DNS errors can embed `IP:port` fragments of their own.
        if (state.server.online) {
            const snap = getSnapshot();
            const sources = [
                java.online ? `java@${sanitizeAddressForLog(java.via) || formatHostPortLog(cfg.host, cfg.port)}` : null,
                bedrock.online ? `bedrock@${cfg.display}` : null
            ].filter(Boolean).join(' + ');
            logger.info(`[MC STATUS] Query succeeded: ${cfg.display} players=${snap.players.online}/${snap.players.max}, version=${snap.version || 'unknown'}, ping=${snap.ping != null ? `${snap.ping}ms` : 'n/a'} (${sources || 'unknown source'})`);
        } else {
            logger.warn(`[MC STATUS] Query failed: ${cfg.display} [timeout=${cfg.timeoutMs}ms] java=${sanitizeAddressForLog(java.error) || 'n/a'}, bedrock=${sanitizeAddressForLog(bedrock.error) || 'n/a'}`);
        }
    } catch (error) {
        logger.error(`Minecraft status poll failed (${reason}): ${error.message}`);
    } finally {
        polling = false;
    }
    // Keep the ONE permanent message in sync (no-op when unconfigured).
    await publish();
    return getSnapshot();
}

function scheduleNext() {
    const cfg = getStatusConfig();
    timer = setTimeout(() => {
        poll('interval').catch(() => {}).finally(scheduleNext);
    }, cfg.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
}

/** Starts monitoring (idempotent). Restores persisted state, then polls. */
async function start(client = null) {
    if (client) setClient(client);
    else if (!discordClient) {
        // Called pre-ready without a client: wait for publish until setClient.
    }
    if (started) return;
    const cfg = getStatusConfig();
    if (!cfg.enabled) {
        logger.info('Minecraft status monitoring is disabled in config.');
        return;
    }
    started = true;
    await ensureHydrated();
    // Adopt the configured channel immediately so a channel change takes effect.
    if (cfg.channelId) state.statusChannelId = state.statusChannelId || cfg.channelId;
    await poll('startup');
    scheduleNext();
    logger.info(`Minecraft status monitor started (${cfg.display}, every ${Math.round(cfg.pollMs / 1000)}s).`);
}

function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    started = false;
}

/**
 * Manual refresh used by /mcstatus and the 🔄 button. Rate-limited so it can
 * never be used to hammer the Minecraft server: within `minRefreshMs` of the
 * last query it returns the cached snapshot without touching the network.
 */
async function refresh() {
    const cfg = getStatusConfig();
    if (Date.now() - lastQueryAt < cfg.minRefreshMs) {
        return { snapshot: getSnapshot(), throttled: true };
    }
    const snapshot = await poll('manual');
    return { snapshot, throttled: false };
}

function getStatusMessageInfo() {
    return { messageId: state.statusMessageId, channelId: state.statusChannelId || getStatusConfig().channelId || null };
}

module.exports = {
    start,
    stop,
    poll,
    refresh,
    publish,
    getSnapshot,
    getStatusConfig,
    uptimeMs,
    setClient,
    getStatusMessageInfo,
    // exposed for tests
    _internal: { state, applyResult, applyServer, hydrate, unflattenEdition, flatten, applyPersistedDoc, faviconEditPlan, getLastPublishedFavicon: () => lastPublishedFavicon, setLastPublishedFavicon: (v) => { lastPublishedFavicon = v; } }
};
