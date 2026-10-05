// Resolves a registered component for a customId.
// Supports exact IDs ("welcome:refresh") and dynamic IDs by prefix
// ("ticket:close:123" matches a component registered as "ticket:close").
function resolveComponent(moduleManager, customId) {
    const components = moduleManager.components;
    if (components.has(customId)) return components.get(customId);

    const parts = customId.split(':');
    while (parts.length > 1) {
        parts.pop();
        const prefix = parts.join(':');
        if (components.has(prefix)) return components.get(prefix);
    }
    return null;
}

module.exports = { resolveComponent };
