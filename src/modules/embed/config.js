// Module-level defaults for the /embed Components V2 builder.
// Per-guild overrides are intentionally NOT implemented yet — this is the
// foundation for future template/permission expansion.

const configService = require('../../core/configService');

function coerceIdList(value) {
    // Role IDs always stay strings — never numbers.
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return items
        .filter((id) => id !== null && id !== undefined && String(id).trim() !== '')
        .map((id) => String(id).trim());
}

const DEFAULTS = {
    enabled: true,
    sessionTimeoutMs: 15 * 60 * 1000, // 15 minutes
    allowedRoleIds: [],
    permissions: {
        administrator: true
    },
    limits: {
        maxTextBlocks: 6,
        maxSeparators: 5,
        maxMediaBlocks: 3,
        maxMediaItemsPerBlock: 10,
        maxButtonRows: 3,
        maxButtonsPerRow: 5,
        maxContainerChildren: 10,
        maxTextLength: 4000
    }
};

function getEmbedBuilderConfig() {
    const file = configService.get('embedBuilder', {}) || {};
    return {
        ...DEFAULTS,
        ...file,
        allowedRoleIds: coerceIdList(file.allowedRoleIds ?? DEFAULTS.allowedRoleIds),
        permissions: { ...DEFAULTS.permissions, ...(file.permissions || {}) },
        limits: { ...DEFAULTS.limits, ...(file.limits || {}) }
    };
}

module.exports = { DEFAULTS, coerceIdList, getEmbedBuilderConfig };
