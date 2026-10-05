const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logDirectory = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        this.write(`[${timestamp}] [${level}] ${message}`);
    }

    raw(message) {
        this.write(message);
    }

    write(formattedMessage) {
        console.log(formattedMessage);

        const logFile = path.join(this.logDirectory, `${new Date().toISOString().split('T')[0]}.log`);
        fs.appendFileSync(logFile, formattedMessage + '\n');
    }

    info(message) { this.log(message, 'INFO'); }
    warn(message) { this.log(message, 'WARN'); }
    error(message) { this.log(message, 'ERROR'); }
    debug(message) { this.log(message, 'DEBUG'); }
}

module.exports = new Logger();
