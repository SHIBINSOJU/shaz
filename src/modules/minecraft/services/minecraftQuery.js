const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
// Centralized log formatter: diagnostics below must NEVER emit `host:port` —
// always the separate `IP: … | Port: …` form (minecraftService is the single
// source of truth; it does not require this module, so no cycle).
const { formatHostPortLog } = require('./minecraftService');

// Minecraft server queries implemented directly on Node's net/dgram — no extra
// dependencies, no plugin, no separate process. Java uses the Server List Ping
// (TCP) handshake; Bedrock uses the RakNet unconnected ping (UDP). Each function
// performs exactly ONE query and resolves/rejects within `timeoutMs`, so callers
// can poll on an interval without ever flooding the server.

const RAKNET_MAGIC = Buffer.from([
    0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
    0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78
]);

// A modern protocol version. The status handshake accepts any value; servers
// reply with their own version, which is what we actually display.
const JAVA_PROTOCOL_VERSION = 767;

// ---------------------------------------------------------------------------
// VarInt codec (Minecraft's variable-length integer encoding)
// ---------------------------------------------------------------------------

function writeVarInt(value) {
    const bytes = [];
    let v = value >>> 0;
    do {
        let temp = v & 0x7f;
        v >>>= 7;
        if (v !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (v !== 0);
    return Buffer.from(bytes);
}

function writeString(str) {
    const buf = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(buf.length), buf]);
}

/**
 * Reads a VarInt at `offset`. Returns { value: null } when the buffer does not
 * yet hold a complete VarInt (more bytes needed), so the caller can wait for the
 * next TCP chunk instead of failing.
 */
function tryReadVarInt(buf, offset) {
    let result = 0;
    let numRead = 0;
    let i = offset;
    for (;;) {
        if (i >= buf.length) return { value: null, size: 0 };
        const read = buf[i];
        i++;
        const value = read & 0x7f;
        result |= (value << (7 * numRead));
        numRead++;
        if (numRead > 5) throw new Error('VarInt is too big');
        if ((read & 0x80) === 0) break;
    }
    return { value: result >>> 0, size: numRead };
}

function framePacket(id, payload) {
    const body = Buffer.concat([writeVarInt(id), payload]);
    return Buffer.concat([writeVarInt(body.length), body]);
}

// ---------------------------------------------------------------------------
// Java — Server List Ping (TCP)
// ---------------------------------------------------------------------------

function extractDescriptionText(desc) {
    if (!desc) return '';
    if (typeof desc === 'string') return desc;
    if (typeof desc === 'object') {
        let out = typeof desc.text === 'string' ? desc.text : '';
        if (Array.isArray(desc.extra)) out += desc.extra.map(extractDescriptionText).join('');
        return out;
    }
    return '';
}

function buildJavaResult(json, ping) {
    const players = json.players || {};
    const sample = Array.isArray(players.sample)
        ? players.sample.map((p) => p && (p.name ?? p.nameText)).filter(Boolean)
        : [];
    const version = json.version || {};
    // Server favicon (data:image/png;base64,...) — used as the Discord
    // thumbnail via an attachment. NOT the bot avatar.
    const favicon = typeof json.favicon === 'string' && json.favicon.startsWith('data:image/')
        ? json.favicon
        : null;
    return {
        edition: 'java',
        online: true,
        players: {
            online: Number(players.online) || 0,
            max: Number(players.max) || 0,
            names: sample
        },
        version: version.name ? String(version.name) : 'Unknown',
        protocol: Number(version.protocol) || null,
        motd: extractDescriptionText(json.description),
        favicon,
        ping
    };
}

/**
 * One Java status query. Resolves with the parsed result (ping in ms) or
 * rejects on timeout/refusal/parse error. Never leaves the socket open.
 */
function queryJava(host, port = 25565, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const socket = new net.Socket();
        let buffer = Buffer.alloc(0);
        let statusJson = null;
        let settled = false;
        let connected = false;
        let connectMs = null;

        const elapsed = () => Date.now() - startedAt;
        // Log/display target — ALWAYS separate IP and Port fields, never
        // `host:port`. Socket behavior below is unchanged (connect still gets
        // host + port as separate arguments).
        const target = formatHostPortLog(host, port);

        // Staged diagnostics — the exact failure stage is preserved so the
        // monitor log shows WHY the query failed instead of a bare timeout.
        // Stages: tcp-connect (no TCP accept) vs status-read (TCP open but no
        // Server List Ping reply). Never fakes success.
        const timeoutError = () => {
            if (!connected) {
                return new Error(`TCP connect to ${target} timed out after ${elapsed()}ms (no TCP accept; server offline, firewall, or Pterodactyl allocation not listening) [timeout=${timeoutMs}ms]`);
            }
            if (statusJson) {
                // Should have been resolved already; defensive only.
                return new Error(`Java query to ${target} timed out after pong stage (${elapsed()}ms) [timeout=${timeoutMs}ms]`);
            }
            return new Error(`Connected to ${target} in ${connectMs}ms but no status response within ${elapsed()}ms (TCP open, Server List Ping unanswered; server starting/crashed, or TCP proxy without MC backend) [timeout=${timeoutMs}ms]`);
        };

        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (err) reject(err); else resolve(result);
        };

        // If we already have the status JSON but never got a pong, the server is
        // still online — resolve with the elapsed round-trip as the ping.
        const timer = setTimeout(() => {
            if (statusJson) {
                finish(null, buildJavaResult(statusJson, Date.now() - startedAt));
            } else {
                finish(timeoutError());
            }
        }, timeoutMs);

        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => {
            if (statusJson) finish(null, buildJavaResult(statusJson, Date.now() - startedAt));
            else finish(timeoutError());
        });
        socket.on('error', (error) => {
            const stage = connected ? 'status-read' : 'tcp-connect';
            const code = error.code ? `${error.code}: ` : '';
            finish(new Error(`Query ${target} failed at ${stage} after ${elapsed()}ms (${code}${error.message}) [timeout=${timeoutMs}ms]`));
        });

        socket.connect(port, host, () => {
            connected = true;
            connectMs = Date.now() - startedAt;
            const handshakeBody = Buffer.concat([
                writeVarInt(JAVA_PROTOCOL_VERSION),
                writeString(String(host)),
                (() => { const p = Buffer.alloc(2); p.writeUInt16BE(port & 0xffff, 0); return p; })(),
                writeVarInt(1) // next state: status
            ]);
            socket.write(framePacket(0x00, handshakeBody));
            socket.write(framePacket(0x00, Buffer.alloc(0))); // status request
        });

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                for (;;) {
                    const header = tryReadVarInt(buffer, 0);
                    if (header.value === null) break;
                    const total = header.size + header.value;
                    if (buffer.length < total) break;

                    const packet = buffer.slice(header.size, total);
                    buffer = buffer.slice(total);

                    const idInfo = tryReadVarInt(packet, 0);
                    if (idInfo.value === null) continue;
                    const packetId = idInfo.value;

                    if (packetId === 0x00 && statusJson === null) {
                        const strLen = tryReadVarInt(packet, idInfo.size);
                        if (strLen.value === null) continue;
                        const start = idInfo.size + strLen.size;
                        const jsonStr = packet.slice(start, start + strLen.value).toString('utf8');
                        statusJson = JSON.parse(jsonStr);
                        const payload = Buffer.alloc(8);
                        payload.writeBigUInt64BE(BigInt(Date.now()));
                        socket.write(framePacket(0x01, payload)); // ping
                    } else if (packetId === 0x01) {
                        finish(null, buildJavaResult(statusJson || {}, Date.now() - startedAt));
                        return;
                    }
                }
            } catch (error) {
                finish(error);
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Bedrock — RakNet unconnected ping (UDP)
// ---------------------------------------------------------------------------

function toInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Parses the semicolon-delimited payload of an unconnected pong:
 * 0 Edition; 1 MOTD line1; 2 Protocol; 3 Version name; 4 Players; 5 Max;
 * 6 Server ID; 7 MOTD line2; 8 Gamemode; 9 Gamemode numeric; 10 Port v4; 11 Port v6
 * Bedrock does not expose player NAMES through this ping — only counts.
 */
function parseBedrockPong(payload, ping) {
    const f = String(payload).split(';');
    return {
        edition: 'bedrock',
        online: true,
        players: { online: toInt(f[4]), max: toInt(f[5]), names: [] },
        version: f[3] ? String(f[3]) : 'Unknown',
        protocol: toInt(f[2]) || null,
        motd: f[1] || '',
        ping
    };
}

/** One Bedrock query. Resolves with the parsed pong or rejects on timeout/error. */
function queryBedrock(host, port = 19132, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let settled = false;
        let socket;
        try {
            socket = dgram.createSocket('udp4');
        } catch (error) {
            reject(error);
            return;
        }

        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            if (err) reject(err); else resolve(result);
        };

        const timer = setTimeout(() => finish(new Error('Bedrock query timed out')), timeoutMs);
        socket.on('error', (error) => finish(error));

        socket.on('message', (msg) => {
            try {
                // 0x1c = unconnected pong. Layout: id(1) time(8) magic(16)
                // serverGuid(8) = 33 bytes, then a 2-byte BE length + UTF-8 payload.
                if (!msg || msg.length < 35 || msg[0] !== 0x1c) return;
                const strLen = msg.readUInt16BE(33);
                const payload = msg.slice(35, 35 + strLen).toString('utf8');
                finish(null, parseBedrockPong(payload, Date.now() - startedAt));
            } catch (error) {
                finish(error);
            }
        });

        const now = BigInt(Date.now()) & 0xffffffffffffffffn;
        const time = Buffer.alloc(8);
        time.writeBigUInt64BE(now);
        const guid = Buffer.alloc(8);
        guid.writeBigUInt64BE((now ^ 0x5afe5afe5afe5afen) & 0xffffffffffffffffn);
        const packet = Buffer.concat([Buffer.from([0x01]), time, RAKNET_MAGIC, guid]);

        socket.send(packet, 0, packet.length, port, host, (error) => {
            if (error) finish(error);
        });
    });
}

// Both queries normalized to { online:false, error } on failure so the monitor
// treats a timeout, refusal, DNS error or malformed reply identically.
// The REAL error text is preserved in `error` (never swallowed): the monitor
// logs it, which is how actual outages get diagnosed instead of showing a
// context-free "Offline".
async function safeQueryJava(host, port, timeoutMs) {
    try {
        const result = await queryJava(host, port, timeoutMs);
        return { ...result, via: formatHostPortLog(host, port) };
    } catch (directError) {
        const directMsg = directError.message || 'unreachable';
        // Pterodactyl/panel setups commonly point the play domain at the real
        // node allocation via a `_minecraft._tcp` SRV record — exactly how the
        // game client itself resolves the address. When the direct IP + Port
        // fails, try the SRV target before reporting offline.
        const srv = await resolveSrvTarget(host);
        if (srv && (srv.host !== host || srv.port !== port)) {
            try {
                const result = await queryJava(srv.host, srv.port, timeoutMs);
                return { ...result, via: formatHostPortLog(srv.host, srv.port) };
            } catch (srvError) {
                const srvMsg = srvError.message || 'unreachable';
                return { edition: 'java', online: false, error: `direct ${formatHostPortLog(host, port)} -> ${directMsg}; srv ${formatHostPortLog(srv.host, srv.port)} -> ${srvMsg} [timeout=${timeoutMs}ms]` };
            }
        }
        const srvNote = srv ? '' : ' (no _minecraft._tcp SRV; direct IP + Port used as-is)';
        return { edition: 'java', online: false, error: `direct ${formatHostPortLog(host, port)} -> ${directMsg}${srvNote} [timeout=${timeoutMs}ms]` };
    }
}

/**
 * Resolves the `_minecraft._tcp.<host>` SRV record (same lookup the vanilla
 * game client performs). Returns { host, port } of the best record, or null
 * when there is none (the direct IP + Port is then correct and used as-is).
 * Never throws; IP literals skip the lookup.
 */
async function resolveSrvTarget(host) {
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || String(host).includes(':')) return null;
    try {
        const records = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`);
        const best = (records || [])
            .filter((r) => r && r.name && Number(r.port) > 0)
            .sort((a, b) => (a.priority - b.priority) || (a.weight - b.weight));
        if (!best.length) return null;
        return { host: String(best[0].name).replace(/\.$/, ''), port: Number(best[0].port) };
    } catch {
        return null;
    }
}

async function safeQueryBedrock(host, port, timeoutMs) {
    try {
        return await queryBedrock(host, port, timeoutMs);
    } catch (error) {
        return { edition: 'bedrock', online: false, error: error.message || 'unreachable' };
    }
}

module.exports = {
    queryJava,
    queryBedrock,
    safeQueryJava,
    safeQueryBedrock,
    resolveSrvTarget,
    // exported for offline unit tests
    _internal: { writeVarInt, tryReadVarInt, buildJavaResult, parseBedrockPong, extractDescriptionText }
};
