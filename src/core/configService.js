const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

class ConfigService {
    constructor() {
        this.configPath = path.join(process.cwd(), 'src', 'config', 'config.yml');
        this.modulesPath = path.join(process.cwd(), 'src', 'config', 'modules.yml');
        
        this.config = {};
        this.modules = {};
        
        this.load();
    }

    load() {
        if (fs.existsSync(this.configPath)) {
            this.config = yaml.parse(fs.readFileSync(this.configPath, 'utf8')) || {};
        }
        
        if (fs.existsSync(this.modulesPath)) {
            this.modules = yaml.parse(fs.readFileSync(this.modulesPath, 'utf8')) || {};
        }
    }

    get(path, defaultValue = null) {
        const parts = path.split('.');
        let current = this.config;
        for (const part of parts) {
            if (current === undefined || current === null) return defaultValue;
            current = current[part];
        }
        return current !== undefined ? current : defaultValue;
    }

    getModuleConfig(moduleName) {
        return this.modules.modules?.[moduleName] ?? false;
    }
}

module.exports = new ConfigService();
