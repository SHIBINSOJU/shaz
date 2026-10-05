const { REST, Routes } = require('discord.js');
const logger = require('../logger');
const startupLogger = require('../startupLogger');
const { withRetry } = require('../../utils/retry');

module.exports = function createClientReadyEvent(ctx) {
    return {
        name: 'clientReady',
        once: true,
        async execute(client) {
            logger.info(`Logged in as ${client.user.tag}!`);

            const stats = ctx.moduleManager.getStats();
            const guildCount = client.guilds.cache.size;

            await deployCommands(client, ctx);

            startupLogger.botReady({
                tag: client.user.tag,
                guilds: guildCount,
                modules: stats.modules,
                commands: stats.commands,
                events: stats.events
            });

            startupLogger.finalSummary({
                modules: stats.modules,
                commands: stats.commands,
                events: stats.events,
                failedCommands: stats.failedCommands,
                failedEvents: stats.failedEvents,
                guilds: guildCount
            });
        }
    };
};

function sanitizeError(error) {
    let msg = String(error?.stack || error?.message || error || 'Unknown error');
    if (process.env.DISCORD_TOKEN) {
        msg = msg.split(process.env.DISCORD_TOKEN).join('[REDACTED_TOKEN]');
    }
    msg = msg.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g, '[REDACTED_TOKEN]');
    return msg;
}

async function deployCommands(client, ctx) {
    const rawCommands = [...ctx.moduleManager.commands.values()];
    const commandData = [];
    const seenNames = new Set();

    for (const cmd of rawCommands) {
        try {
            if (!cmd?.data || typeof cmd.data.toJSON !== 'function') {
                throw new Error(`Command "${cmd?.data?.name || 'unknown'}" is missing a valid SlashCommandBuilder data property.`);
            }
            const json = cmd.data.toJSON();
            if (!json?.name) {
                throw new Error(`Command produced invalid JSON with no name.`);
            }
            if (seenNames.has(json.name)) {
                throw new Error(`Duplicate command name "/${json.name}" detected in command registration list.`);
            }
            seenNames.add(json.name);
            commandData.push(json);
        } catch (err) {
            const sanitized = sanitizeError(err.message);
            logger.error(`Failed to prepare commands for registration: ${sanitized}`);
            startupLogger.commandRegistrationFailed(`Command validation error: ${sanitized}`);
            return;
        }
    }

    if (commandData.length === 0) {
        logger.warn('No commands discovered to register.');
        startupLogger.commandRegistrationFailed('No commands loaded to register.');
        return;
    }

    const clientId = client.application?.id || (process.env.CLIENT_ID || '').trim();
    const guildIds = (process.env.GUILD_ID || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    const token = (process.env.DISCORD_TOKEN || '').trim();

    if (!token) {
        logger.error('DISCORD_TOKEN is missing in environment variables.');
        startupLogger.commandRegistrationFailed('DISCORD_TOKEN is missing in environment variables.');
        return;
    }

    if (!clientId) {
        logger.error('CLIENT_ID is not set in environment variables.');
        startupLogger.commandRegistrationFailed('CLIENT_ID is missing in environment variables.');
        return;
    }

    if (guildIds.length === 0) {
        logger.error('GUILD_ID is not set in environment variables (guild registration required).');
        startupLogger.commandRegistrationFailed('GUILD_ID is missing in environment variables (guild registration required).');
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);
    const guildIdDisplay = guildIds.join(', ');

    startupLogger.commandRegistrationStart({
        count: commandData.length,
        guildId: guildIdDisplay
    });

    try {
        await withRetry(async () => {
            for (const guildId of guildIds) {
                // Bulk PUT replaces the guild's current slash command list.
                // Stale/renamed commands are removed and new ones are updated instantly.
                await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
                logger.info(`Successfully registered ${commandData.length} commands to guild ${guildId}.`);
            }
        }, {
            attempts: 3,
            delayMs: 2000,
            onRetry: (attempt, error) => logger.warn(`Slash command registration retry (attempt ${attempt}): ${sanitizeError(error.message)}`)
        });

        startupLogger.commandRegistrationSuccess(commandData.length);
    } catch (error) {
        const sanitizedReason = sanitizeError(error.rawError?.message || error.message || error);
        logger.error(`Slash command registration failed: ${sanitizedReason}`);
        startupLogger.commandRegistrationFailed(sanitizedReason);
    }
}
