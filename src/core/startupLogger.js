const logger = require('./logger');

const LINE = '━'.repeat(44);
const BOX_WIDTH = 38;

function boxLine(content) {
    return `║ ${content.padEnd(BOX_WIDTH - 2)} ║`;
}

class StartupLogger {
    banner(title) {
        logger.raw('');
        logger.raw(LINE);
        logger.raw(`        ${title}`);
        logger.raw(LINE);
        logger.raw('');
    }

    line(message = '') {
        logger.raw(message);
    }

    moduleLoaded(name, commandCount, eventCount) {
        logger.raw(`✅ Module loaded: ${name}`);
        logger.raw(`   ├─ Commands: ${commandCount}`);
        logger.raw(`   └─ Events: ${eventCount}`);
        logger.raw('');
    }

    commandLoaded(name, moduleName) {
        logger.raw(`✅ Command loaded: /${name} [${moduleName}]`);
    }

    eventLoaded(name, moduleName) {
        logger.raw(`✅ Event loaded: ${name} [${moduleName}]`);
    }

    commandFailed(name, reason) {
        logger.raw(`❌ Failed to load command: /${name}`);
        logger.raw(`   Reason: ${reason}`);
    }

    eventFailed(name, reason) {
        logger.raw(`❌ Failed to load event: ${name}`);
        logger.raw(`   Reason: ${reason}`);
    }

    commandsSection(commands) {
        this.banner('📋 COMMANDS');
        if (commands.length === 0) {
            logger.raw('No commands loaded.');
        } else {
            for (const cmd of commands) {
                logger.raw(`✅ Loaded command: /${cmd.name}`);
            }
        }
        logger.raw('');
        logger.raw(`📊 Total Commands Loaded: ${commands.length}`);
        logger.raw('');
    }

    eventsSection(events) {
        this.banner('⚡ EVENTS');
        if (events.length === 0) {
            logger.raw('No events loaded.');
        } else {
            for (const event of events) {
                logger.raw(`✅ Loaded event: ${event.name}`);
            }
        }
        logger.raw('');
        logger.raw(`📊 Total Events Loaded: ${events.length}`);
        logger.raw('');
    }

    moduleSummary(modules) {
        this.banner('📦 MODULE SUMMARY');
        if (modules.length === 0) {
            logger.raw('No modules loaded.');
        } else {
            for (const mod of modules) {
                logger.raw(mod.name);
                logger.raw(`  Commands: ${mod.commands}`);
                logger.raw(`  Events: ${mod.events}`);
                logger.raw('');
            }
        }
    }

    commandRegistrationStart({ count, guildId }) {
        logger.raw('');
        logger.raw('━'.repeat(30));
        logger.raw('       COMMAND REGISTRATION');
        logger.raw('━'.repeat(30));
        logger.raw('');
        logger.raw(`📦 Commands loaded: ${count}`);
        logger.raw('🌐 Registration: Guild');
        logger.raw(`🏠 Guild ID: ${guildId}`);
        logger.raw('🔄 Syncing commands...');
        logger.raw('');
    }

    commandRegistrationSuccess(count) {
        logger.raw(`✅ Successfully registered ${count} commands`);
        logger.raw('');
        logger.raw('━'.repeat(30));
        logger.raw('');
    }

    commandRegistrationFailed(reason) {
        logger.raw('❌ Failed to register commands');
        logger.raw('');
        logger.raw('Reason:');
        logger.raw(reason);
        logger.raw('');
        logger.raw('━'.repeat(30));
        logger.raw('');
    }

    botReady({ tag, guilds, modules, commands, events }) {
        this.banner('🚀 BOT READY');
        logger.raw(`📦 Modules: ${modules}`);
        logger.raw(`📋 Commands: ${commands}`);
        logger.raw(`⚡ Events: ${events}`);
        logger.raw('');
        logger.raw(`🤖 Logged in as: ${tag}`);
        logger.raw(`🏠 Guilds: ${guilds}`);
        logger.raw('');
        logger.raw(LINE);
    }

    finalSummary({ modules, commands, events, failedCommands, failedEvents, guilds }) {
        logger.raw('');
        logger.raw(`╔${'═'.repeat(BOX_WIDTH)}╗`);
        logger.raw(boxLine('🚀 STARTUP COMPLETE'.padStart(Math.floor((BOX_WIDTH - 2 + 19) / 2))));
        logger.raw(`╠${'═'.repeat(BOX_WIDTH)}╣`);
        logger.raw(boxLine(`📦 Modules: ${String(modules).padStart(BOX_WIDTH - 16)}`));
        logger.raw(boxLine(`📋 Commands: ${String(commands).padStart(BOX_WIDTH - 17)}`));
        logger.raw(boxLine(`⚡ Events: ${String(events).padStart(BOX_WIDTH - 15)}`));
        logger.raw(boxLine(`❌ Failed Commands: ${String(failedCommands).padStart(BOX_WIDTH - 24)}`));
        logger.raw(boxLine(`❌ Failed Events: ${String(failedEvents).padStart(BOX_WIDTH - 22)}`));
        logger.raw(boxLine(`🏠 Guilds: ${String(guilds).padStart(BOX_WIDTH - 15)}`));
        logger.raw(`╚${'═'.repeat(BOX_WIDTH)}╝`);
        logger.raw('');
    }
}

module.exports = new StartupLogger();
