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

// In-memory cooldown tracker: key `${channelId}:${userId}` -> timestamp (ms)
const lastTriggered = new Map();

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
                address: String(java.address || 'risesmp.online').trim(),
                port: Number(java.port ?? 25890)
            },
            bedrock: {
                address: String(bedrock.address || 'risesmp.online').trim(),
                port: bedrock.port !== undefined && bedrock.port !== null && String(bedrock.port).trim() !== ''
                    ? String(bedrock.port).trim()
                    : '<BEDROCK_PORT>'
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

/** `risesmp.online:25890` (port only appended when it differs from the default). */
function formatJavaAddress(config) {
    const host = config.ipResponse.java.address;
    const port = config.ipResponse.java.port;
    return port && Number(port) !== 25565 ? `${host}:${port}` : host;
}

/** Address + configured Bedrock/Geyser port (never guessed — config.yml only). */
function formatBedrockAddress(config) {
    const host = config.ipResponse.bedrock.address;
    const port = config.ipResponse.bedrock.port;
    return port ? `${host}:${port}` : host;
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
    const bedrockDisplay = formatBedrockAddress(config);

    const container = new ContainerBuilder().setAccentColor(config.accentColor);
    const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎮 ${config.serverName}`));

    if (edition === 'bedrock') {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### 🪨 BEDROCK EDITION\n\n\`${bedrockDisplay}\``
        ));
    } else {
        container.addSeparatorComponents(divider());
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### ☕ JAVA EDITION\n\n\`${javaDisplay}\``
        ));
        if (edition !== 'java') {
            container.addSeparatorComponents(divider());
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `### 🪨 BEDROCK EDITION\n\n\`${bedrockDisplay}\``
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
 * The public keyword trigger. Contains NO address — only the announcement and
 * the edition buttons. The IP itself is rendered exclusively by the ephemeral
 * mc:ip:* interaction reply, so the channel never sees it.
 */
function buildIpPrompt(config, edition = 'all', requesterName = '') {
    const safeName = String(requesterName).replace(/[*_`~<>\\@]/g, '').trim();
    const who = safeName ? `**${safeName}** asked for the server IP — t` : 'T';
    const container = new ContainerBuilder().setAccentColor(config.accentColor);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## 🎮 ${config.serverName}\n-# 🔒 ${who}ap a button below — the address is shown privately, only you will see it.`
    ));

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container, buildIpRow(edition)],
        allowedMentions: NO_MENTIONS
    };
}

module.exports = {
    getMinecraftConfig,
    checkCooldown,
    detectIpQuery,
    buildIpResponse,
    buildIpPrompt
};
