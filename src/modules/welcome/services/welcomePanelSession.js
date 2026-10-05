// Shared panel state for /welcome: resolves the EXISTING welcome configuration
// (config.yml → GuildSettings → unsaved draft) and renders the panel views.
// Used by both the slash command and the component router so the two can never
// disagree about what the settings currently are.

const { isDatabaseReady } = require('../../../database/connection');
const { PANEL_FIELDS, resolveWelcomeConfig } = require('./settings');
const { buildMainPanel, buildChannelPanel, buildTogglePanel, buildPreview } = require('./welcomePanel');
const { createSession } = require('./welcomePanelStore');

function isUsableChannel(channel) {
    return Boolean(channel) && channel.isTextBased() && channel.viewable !== false;
}

/** The configured channel, or null → panel shows "⚠️ Channel not configured". */
async function resolvePanelChannel(guild, channelId) {
    if (!channelId || !guild?.channels?.fetch) return null;
    try {
        const channel = await guild.channels.fetch(channelId);
        return isUsableChannel(channel) ? channel : null;
    } catch {
        // Deleted channel, missing access or a REST timeout: the panel must still open.
        return null;
    }
}

function isDirty(draft, persisted) {
    return PANEL_FIELDS.some((field) => {
        if (!draft || draft[field] === undefined) return false;
        const next = draft[field];
        const current = persisted[field];
        if (typeof next === 'string' || typeof current === 'string') {
            return String(next ?? '') !== String(current ?? '');
        }
        return Boolean(next) !== Boolean(current);
    });
}

async function panelState(guild, draft) {
    const config = await resolveWelcomeConfig(guild, draft);
    const channel = await resolvePanelChannel(guild, config.channelId);
    // Only hit the resolver twice when there is actually something to compare.
    const persisted = draft && Object.keys(draft).length > 0
        ? await resolveWelcomeConfig(guild, null)
        : config;
    return { config, channel, dirty: isDirty(draft, persisted), dbReady: isDatabaseReady() };
}

function openPanel(interaction) {
    return createSession({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        openedBy: interaction.user.displayName ?? interaction.user.username,
        draft: {}
    });
}

async function renderMainPanel(session, guild, { notice } = {}) {
    const { config, channel, dirty, dbReady } = await panelState(guild, session.draft);
    return buildMainPanel({
        sessionId: session.id,
        config,
        channel,
        dirty,
        dbReady,
        notice,
        openedBy: session.openedBy
    });
}

async function renderChannelPanel(session, guild) {
    const { config, channel } = await panelState(guild, session.draft);
    return buildChannelPanel({ sessionId: session.id, config, channel });
}

async function renderTogglePanel(session, guild, field) {
    const { config } = await panelState(guild, session.draft);
    return buildTogglePanel({ sessionId: session.id, field, config });
}

// Delegates to the production WelcomeBuilder — same code path as guildMemberAdd.
async function renderPreviewPanel(session, guild, member) {
    const { config } = await panelState(guild, session.draft);
    return buildPreview({ sessionId: session.id, config, member });
}

module.exports = {
    isUsableChannel,
    resolvePanelChannel,
    panelState,
    openPanel,
    renderMainPanel,
    renderChannelPanel,
    renderTogglePanel,
    renderPreviewPanel
};
