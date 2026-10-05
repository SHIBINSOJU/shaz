const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const startupLogger = require('./startupLogger');

class ModuleManager {
    constructor(client, configService) {
        this.client = client;
        this.config = configService;
        this.modules = new Map();
        
        this.commands = new Map();
        this.events = new Map();
        this.components = new Map();

        // Maps command/event name -> module name, so statistics are always
        // derived from what was actually registered (dedup-safe on reloads).
        this.commandModules = new Map();
        this.eventModules = new Map();
        this.failedCommands = [];
        this.failedEvents = [];
    }

    async loadModules(coreModule = null) {
        startupLogger.banner('🤖 BOT INITIALIZATION');
        startupLogger.line('📦 Loading modules...');
        startupLogger.line('');

        if (coreModule) {
            try {
                await this.registerModule(coreModule);
                logger.info(`Successfully loaded module: ${coreModule.name}`);
                startupLogger.moduleLoaded(
                    coreModule.name,
                    this.countForModule(this.commandModules, coreModule.name),
                    this.countForModule(this.eventModules, coreModule.name)
                );
            } catch (error) {
                logger.error(`Failed to load core module: ${error.message}`);
            }
        }

        const modulesPath = path.join(process.cwd(), 'src', 'modules');
        
        if (!fs.existsSync(modulesPath)) {
            logger.warn('Modules directory does not exist. Creating it...');
            fs.mkdirSync(modulesPath, { recursive: true });
            this.printLoadSummary();
            return;
        }

        const moduleFolders = fs.readdirSync(modulesPath).filter(file => {
            return fs.statSync(path.join(modulesPath, file)).isDirectory();
        });

        for (const folder of moduleFolders) {
            // Check if module is enabled in configuration
            const isEnabled = this.config.getModuleConfig(folder);
            if (!isEnabled) {
                logger.info(`Module [${folder}] is disabled in configuration. Skipping.`);
                continue;
            }

            try {
                const modulePath = path.join(modulesPath, folder, 'index.js');
                if (fs.existsSync(modulePath)) {
                    const moduleDef = require(modulePath);
                    await this.registerModule(moduleDef);
                    logger.info(`Successfully loaded module: ${folder}`);
                    startupLogger.moduleLoaded(
                        moduleDef.name || folder,
                        this.countForModule(this.commandModules, moduleDef.name || folder),
                        this.countForModule(this.eventModules, moduleDef.name || folder)
                    );
                } else {
                    logger.warn(`Module ${folder} is missing index.js entry point.`);
                }
            } catch (error) {
                logger.error(`Failed to load module ${folder}: ${error.message}`);
            }
        }

        this.printLoadSummary();
    }

    async registerModule(moduleDef) {
        if (!moduleDef.name) {
            throw new Error('Module missing required "name" property.');
        }

        this.modules.set(moduleDef.name, moduleDef);

        if (moduleDef.initialize && typeof moduleDef.initialize === 'function') {
            await moduleDef.initialize({ client: this.client, config: this.config });
        }

        if (moduleDef.commands && Array.isArray(moduleDef.commands)) {
            for (const cmd of moduleDef.commands) {
                try {
                    if (!cmd || typeof cmd !== 'object') {
                        throw new Error('Command definition is not an object.');
                    }
                    if (!cmd.data) {
                        throw new Error('Command is missing "data" (SlashCommandBuilder).');
                    }
                    if (!cmd.data.name || typeof cmd.data.name !== 'string') {
                        throw new Error('Command data is missing a valid "name".');
                    }
                    if (typeof cmd.execute !== 'function') {
                        throw new Error(`Command /${cmd.data.name} is missing an "execute" function.`);
                    }
                    if (typeof cmd.data.toJSON !== 'function') {
                        throw new Error(`Command /${cmd.data.name} "data" must have a "toJSON()" method.`);
                    }

                    const json = cmd.data.toJSON();
                    if (!json || !json.name) {
                        throw new Error(`Command /${cmd.data.name} toJSON() output is missing "name".`);
                    }

                    if (this.commands.has(cmd.data.name)) {
                        const existingModule = this.commandModules.get(cmd.data.name) || 'unknown';
                        const reason = `Duplicate command name "/${cmd.data.name}" detected in module "${moduleDef.name}" (already registered by module "${existingModule}").`;
                        this.failedCommands.push({ name: cmd.data.name, module: moduleDef.name, reason });
                        startupLogger.commandFailed(cmd.data.name, reason);
                        continue;
                    }

                    this.commands.set(cmd.data.name, cmd);
                    this.commandModules.set(cmd.data.name, moduleDef.name);
                    startupLogger.commandLoaded(cmd.data.name, moduleDef.name);
                } catch (error) {
                    const name = cmd?.data?.name || 'unknown';
                    this.failedCommands.push({ name, module: moduleDef.name || 'unknown', reason: error.message });
                    startupLogger.commandFailed(name, error.message);
                }
            }
        }

        if (moduleDef.events && Array.isArray(moduleDef.events)) {
            for (const event of moduleDef.events) {
                try {
                    if (event.once) {
                        this.client.once(event.name, (...args) => event.execute(...args, this.client));
                    } else {
                        this.client.on(event.name, (...args) => event.execute(...args, this.client));
                    }

                    this.events.set(event.name, event);
                    this.eventModules.set(event.name, moduleDef.name);
                    startupLogger.eventLoaded(event.name, moduleDef.name);
                } catch (error) {
                    this.failedEvents.push({ name: event?.name || 'unknown', reason: error.message });
                    startupLogger.eventFailed(event?.name || 'unknown', error.message);
                }
            }
        }

        if (moduleDef.components && Array.isArray(moduleDef.components)) {
            for (const comp of moduleDef.components) {
                this.components.set(comp.customId, comp);
            }
        }
    }

    countForModule(map, moduleName) {
        let count = 0;
        for (const owner of map.values()) {
            if (owner === moduleName) count++;
        }
        return count;
    }

    getStats() {
        return {
            modules: this.modules.size,
            commands: this.commands.size,
            events: this.events.size,
            failedCommands: this.failedCommands.length,
            failedEvents: this.failedEvents.length
        };
    }

    printLoadSummary() {
        const commands = [...this.commandModules.entries()].map(([name, moduleName]) => ({ name, moduleName }));
        const events = [...this.eventModules.entries()].map(([name, moduleName]) => ({ name, moduleName }));
        const modules = [...this.modules.keys()].map(name => ({
            name,
            commands: this.countForModule(this.commandModules, name),
            events: this.countForModule(this.eventModules, name)
        }));

        startupLogger.line('');
        startupLogger.commandsSection(commands);
        startupLogger.eventsSection(events);
        startupLogger.moduleSummary(modules);
        startupLogger.line(`⚠️ Failed Commands: ${this.failedCommands.length}`);
        startupLogger.line(`⚠️ Failed Events: ${this.failedEvents.length}`);
    }
}

module.exports = ModuleManager;
