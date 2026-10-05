const mongoose = require('mongoose');
const logger = require('../core/logger');

let connected = false;

async function connectDatabase(uri) {
    if (!uri) {
        logger.warn('MONGODB_URI is not set. Skipping database connection (warning system will be unavailable).');
        return false;
    }

    try {
        mongoose.connection.on('connected', () => {
            connected = true;
            logger.info('MongoDB connected.');
        });
        mongoose.connection.on('disconnected', () => {
            connected = false;
            logger.warn('MongoDB disconnected.');
        });
        mongoose.connection.on('error', (error) => {
            logger.error(`MongoDB connection error: ${error.message}`);
        });

        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
        return true;
    } catch (error) {
        connected = false;
        logger.error(`Failed to connect to MongoDB: ${error.message}`);
        logger.warn('Continuing without database. Features that need persistence (warnings, per-guild settings) will report errors gracefully.');
        return false;
    }
}

function isDatabaseReady() {
    return connected && mongoose.connection.readyState === 1;
}

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('Database is not connected. This action requires MongoDB.');
    }
}

module.exports = { connectDatabase, isDatabaseReady, requireDatabase };
