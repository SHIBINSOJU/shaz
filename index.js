require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./src/core/logger');
const configService = require('./src/core/configService');
const ModuleManager = require('./src/core/moduleManager');
const createCoreModule = require('./src/core/coreModule');
const { connectDatabase } = require('./src/database/connection');
const { isTransientError } = require('./src/utils/retry');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const moduleManager = new ModuleManager(client, configService);

client.on('error', (error) => {
    logger.error(`Client error: ${error.message}`);
});

process.on('unhandledRejection', (error) => {
    if (error && error.message === 'Used disallowed intents') {
        logger.error('Privileged intents are enabled in code but not in the Discord Developer Portal.');
        logger.error('Go to https://discord.com/developers/applications -> Bot -> Privileged Gateway Intents');
        logger.error('and turn on "Server Members Intent" and "Message Content Intent", then save and restart.');
        process.exit(1);
    }
    if (isTransientError(error)) {
        logger.warn(`Transient network blip (ignored, the client reconnects on its own): ${error?.message || error}`);
        return;
    }
    logger.error(`Unhandled promise rejection: ${error}`);
});

process.on('uncaughtException', (error) => {
    // Flaky networks can abort the gateway WebSocket handshake; discord.js
    // retries the connection by itself, so this must not look fatal.
    if (isTransientError(error)) {
        logger.warn(`Transient network blip (ignored, the client reconnects on its own): ${error.message}`);
        return;
    }
    logger.error(`Uncaught exception: ${error.stack || error}`);
});

if (!process.env.DISCORD_TOKEN) {
    logger.error('DISCORD_TOKEN is missing in environment variables.');
    process.exit(1);
}

async function loginWithRetry(maxAttempts = 8, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await client.login(process.env.DISCORD_TOKEN);
            return;
        } catch (error) {
            // A bad token or config never heals — only ride out network blips.
            if (!isTransientError(error)) throw error;
            if (attempt === maxAttempts) throw error;
            const wait = Math.min(delayMs * attempt, 30000);
            logger.warn(`Login attempt ${attempt}/${maxAttempts} failed (${error.message}). Retrying in ${Math.round(wait / 1000)}s...`);
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }
}

async function start() {
    await connectDatabase(process.env.MONGODB_URI);

    const ctx = { client, moduleManager, config: configService };
    await moduleManager.loadModules(createCoreModule(ctx));

    await loginWithRetry();
}

start().catch((error) => {
    logger.error(`Fatal startup error: ${error.stack || error}`);
    process.exit(1);
});
