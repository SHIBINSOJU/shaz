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

module.exports = {
    getMinecraftConfig,
    buildIpResponse
};
