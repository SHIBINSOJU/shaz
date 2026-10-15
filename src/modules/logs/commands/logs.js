// /logs — per-category server logging configuration.
// Conventions follow /setup and /autorole: Manage Server gate, ephemeral
// deferred replies, Components V2 status output, never rely on hidden UI.
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType
} = require('discord.js');
const logger = require('../../../core/logger');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { CATEGORIES, CATEGORY_KEYS, isValidCategory } = require('../config');
const { getLogsConfig, getCategoryConfig, setCategoryChannel, setCategoryEnabled } = require('../services/logConfig');
const { sendLog } = require('../services/logDispatcher');
const { renderPanel } = require('../services/logsPanel');
const { createSession } = require('../components/logsRouter');
const { BRAND_RED } = require('../../../utils/brandColor');

function categoryOption(option, { required = true } = {}) {
    option.setName('category').setDescription('Which log category to configure').setRequired(required);
    for (const key of CATEGORY_KEYS) {
        option.addChoices({ name: `${CATEGORIES[key].emoji} ${CATEGORIES[key].label}`, value: key });
    }
    return option;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('logs')
        .setDescription('Configure per-category server logging.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('Open the interactive logging configuration panel.'))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show every log category, its state and destination channel.'))
        .addSubcommand(sub => sub
            .setName('channel')
            .setDescription('Set the destination channel for a log category.')
            .addStringOption(o => categoryOption(o))
            .addChannelOption(o => o.setName('channel')
                .setDescription('Destination channel (omit to clear)')
                .setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(sub => sub
            .setName('enable')
            .setDescription('Enable a log category.')
            .addStringOption(o => categoryOption(o)))
        .addSubcommand(sub => sub
            .setName('disable')
            .setDescription('Disable a log category.')
            .addStringOption(o => categoryOption(o)))
        .addSubcommand(sub => sub
            .setName('test')
            .setDescription('Send a test log message to a category channel.')
            .addStringOption(o => categoryOption(o)))
        .addSubcommand(sub => sub
            .setName('view')
            .setDescription('Show recent log entries for a category.')
            .addStringOption(o => categoryOption(o))
            .addIntegerOption(o => o.setName('limit')
                .setDescription('How many recent entries to show (1-10)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10))),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need **Manage Server** permission to configure logging.', flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();

        try {
            switch (sub) {
                case 'setup': return await openSetup(interaction);
                case 'status': return await showStatus(interaction);
                case 'channel': return await setChannel(interaction);
                case 'enable': return await setToggle(interaction, true);
                case 'disable': return await setToggle(interaction, false);
                case 'test': return await sendTest(interaction);
                case 'view': return await viewLogs(interaction);
                default: return await interaction.reply({ content: '❌ Unknown logs subcommand.', flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error(`/logs ${sub} failed: ${error.stack || error}`);
            const message = `❌ Failed: ${error.message}`;
            try {
                if (interaction.deferred || interaction.replied) await interaction.editReply(message);
                else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
            } catch { /* response window closed */ }
        }
    }
};

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

function requireCategory(interaction) {
    const category = interaction.options.getString('category', true);
    if (!isValidCategory(category)) throw new Error('Unknown log category.');
    return category;
}

async function openSetup(interaction) {
    const session = createSession(interaction.user.id, interaction.guild.id);
    const payload = await renderPanel(session, interaction.guild);
    await interaction.reply({ ...payload, flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] });
}

async function showStatus(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = await getLogsConfig(interaction.guild.id);
    const fields = CATEGORY_KEYS.map(key => ({
        label: `${CATEGORIES[key].emoji} ${CATEGORIES[key].label}`,
        value: `${cfg[key].enabled ? '🟢 Enabled' : '🔴 Disabled'} → ${cfg[key].channelId ? `<#${cfg[key].channelId}>` : '_not set_'}`
    }));
    await interaction.editReply({
        ...buildInfoContainer({
            header: `📋 Logging status for **${interaction.guild.name}**`,
            fields,
            accent: BRAND_RED,
            footer: 'Configure with /logs setup or /logs channel • Test with /logs test'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function setChannel(interaction) {
    requireDatabase();
    const category = requireCategory(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel');
    if (channel && !channel.isTextBased?.()) {
        await interaction.editReply('❌ That channel cannot receive log messages. Choose a text channel.');
        return;
    }
    await setCategoryChannel(interaction.guild.id, category, channel ? channel.id : null);
    logger.info(`Log channel updated: guild ${interaction.guild.id} category ${category} -> ${channel ? `#${channel.name}` : 'cleared'} by ${interaction.user.id}`);
    await interaction.editReply(channel
        ? `✅ ${CATEGORIES[category].emoji} **${CATEGORIES[category].label}** will now be sent to ${channel}.`
        : `✅ ${CATEGORIES[category].emoji} **${CATEGORIES[category].label}** channel cleared — events for this category will be skipped.`);
}

async function setToggle(interaction, enabled) {
    requireDatabase();
    const category = requireCategory(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await setCategoryEnabled(interaction.guild.id, category, enabled);
    await interaction.editReply(`✅ ${CATEGORIES[category].emoji} **${CATEGORIES[category].label}** ${enabled ? '**enabled**' : '**disabled**'} for this server.`);
}

async function sendTest(interaction) {
    const category = requireCategory(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await sendLog(interaction.guild, category, {
        emoji: '📨',
        title: `Test Log — ${CATEGORIES[category].label}`,
        accent: BRAND_RED,
        thumbnailUrl: interaction.guild.iconURL?.({ size: 128 }) || null,
        fields: [
            { label: 'Category', value: CATEGORIES[category].label },
            { label: 'Requested by', value: `${interaction.user} (\`${interaction.user.id}\`)` },
            { label: 'Note', value: 'If you can read this, the destination channel and permissions are correct.' }
        ],
        footer: `Server ID: ${interaction.guild.id}`
    });
    await interaction.editReply(ok
        ? `✅ Test log sent to the ${CATEGORIES[category].label} channel.`
        : '⚠️ Test log could not be delivered — set a channel with `/logs channel` and check my **View Channel** / **Send Messages** permissions.');
}

// Best-effort title for a logged message: first TextDisplay line of a
// Components V2 container, otherwise a content snippet. Never throws.
function entryTitle(message) {
    try {
        for (const component of message.components || []) {
            const json = typeof component.toJSON === 'function' ? component.toJSON() : null;
            const text = findFirstText(json);
            if (text) return text.split('\n')[0].slice(0, 80);
        }
    } catch { /* fall through to content */ }
    const content = String(message.content || '').split('\n')[0].slice(0, 80);
    return content || '_no text_';
}

function findFirstText(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.content === 'string' && node.content.trim()) return node.content.trim();
    const children = node.components;
    if (Array.isArray(children)) {
        for (const child of children) {
            const hit = findFirstText(child);
            if (hit) return hit;
        }
    }
    return null;
}

async function viewLogs(interaction) {
    const category = requireCategory(interaction);
    const limit = interaction.options.getInteger('limit') || 5;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getCategoryConfig(interaction.guild.id, category);
    if (!cfg.enabled) {
        await interaction.editReply(`⚠️ ${CATEGORIES[category].emoji} **${CATEGORIES[category].label}** is disabled. Enable it with \`/logs enable\`.`);
        return;
    }
    if (!cfg.channelId) {
        await interaction.editReply(`⚠️ ${CATEGORIES[category].emoji} **${CATEGORIES[category].label}** has no channel yet. Set one with \`/logs channel\` or \`/logs setup\`.`);
        return;
    }

    const channel = await interaction.guild.channels.fetch(String(cfg.channelId)).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
        await interaction.editReply('⚠️ The configured log channel no longer exists or is not a text channel. Set a new one with `/logs channel`.');
        return;
    }

    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor?.(me);
    if (perms && (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory))) {
        await interaction.editReply('⚠️ I cannot read that log channel — I need **View Channel** and **Read Message History** there.');
        return;
    }

    let messages;
    try {
        messages = await channel.messages.fetch({ limit });
    } catch (error) {
        logger.error(`/logs view fetch failed: ${error.message}`);
        await interaction.editReply('❌ Could not read that log channel. Check my permissions and try again.');
        return;
    }

    const entries = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (entries.length === 0) {
        await interaction.editReply(`📋 No entries in ${channel} yet — ${CATEGORIES[category].label} will appear here as events happen.`);
        return;
    }

    const lines = entries.map((msg) => {
        const when = `<t:${Math.floor(msg.createdTimestamp / 1000)}:R>`;
        return `• [${entryTitle(msg)}](${msg.url}) — ${when}`;
    });

    await interaction.editReply({
        ...buildInfoContainer({
            header: `${CATEGORIES[category].emoji} Recent ${CATEGORIES[category].label} — <#${channel.id}>`,
            fields: [{ label: `Last ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, value: lines.join('\n') }],
            accent: CATEGORIES[category].accent,
            footer: 'Full log cards live in the channel — click an entry to jump to it.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
