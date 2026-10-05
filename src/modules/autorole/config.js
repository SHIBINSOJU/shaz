// Autorole defaults and effective-config resolution.
//
// Effective settings = config.yml defaults overlaid with per-guild MongoDB
// overrides (GuildSettings.autorole). Never throws — falls back to file
// config when the database is unavailable.
//
// Reserved for future expansion (per-invite roles, verification-gated roles,
// account-age rules, temporary roles): add keys here and merge them the same way.

const configService = require('../../core/configService');
const guildSettingsRepository = require('../../database/repositories/guildSettingsRepository');

const DEFAULTS = {
    enabled: false,
    roles: [],
    bots: false,
    delay: 0,
    logs: {
        enabled: true
    },
    // --- Future expansion (not enforced yet) ---
    inviteRoles: {},
    verificationRoles: [],
    minAccountAgeMs: 0,
    temporaryRoles: {}
};

async function resolveAutoroleConfig(guild) {
    const base = { ...DEFAULTS, ...(configService.get('autorole', {}) || {}) };
    base.logs = { ...DEFAULTS.logs, ...(base.logs || {}) };

    let db = null;
    try {
        db = await guildSettingsRepository.getGuildSettings(guild.id);
    } catch {
        db = null;
    }

    const enabled = db?.autorole?.enabled ?? base.enabled ?? false;
    // A stored array (even empty, e.g. after /autorole clear) always wins
    // over file defaults so clearing is never undone by config.yml.
    const roles = Array.isArray(db?.autorole?.roles)
        ? db.autorole.roles
        : (Array.isArray(base.roles) ? base.roles : []);
    const bots = db?.autorole?.bots ?? base.bots ?? false;
    const delay = db?.autorole?.delay ?? base.delay ?? 0;

    return { ...base, enabled, roles, bots, delay };
}

module.exports = { DEFAULTS, resolveAutoroleConfig };
