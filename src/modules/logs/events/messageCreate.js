// Caches every non-partial message so messageDelete can show content that
// the gateway no longer provides. Registered as its own listener (the
// ModuleManager allows several modules to listen to messageCreate).
const messageCache = require('../services/messageCache');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            if (!message?.guildId) return;
            messageCache.track(message);
        } catch { /* never break message handling */ }
    }
};
