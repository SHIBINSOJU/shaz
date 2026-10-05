const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { buildInfoContainer } = require('../../utils/componentsV2');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all available commands, or show details for one command.')
        .addStringOption(option =>
            option.setName('command').setDescription('Command name to inspect (without /)').setRequired(false)),

    async execute(interaction, ctx) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const query = interaction.options.getString('command')?.toLowerCase().replace(/^\//, '');
        if (query) {
            await showCommandDetails(interaction, ctx, query);
        } else {
            await showCommandList(interaction, ctx);
        }
    }
};

// Display labels per module. Unknown modules fall back to their own name,
// so newly added modules appear automatically without touching this file.
const CATEGORY_LABELS = {
    Utility: '🛠️ Utility',
    Management: '📢 Management',
    Personal: '👤 Personal',
    Fun: '🎉 Fun'
};

function groupCommandsByModule(moduleManager) {
    const groups = new Map();
    for (const [name, moduleName] of moduleManager.commandModules) {
        const label = CATEGORY_LABELS[moduleName] ?? moduleName;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(name);
    }
    return groups;
}

async function showCommandList(interaction, ctx) {
    const mm = ctx.moduleManager;
    const groups = groupCommandsByModule(mm);

    const fields = [...groups.entries()].map(([moduleName, names]) => ({
        label: moduleName,
        value: names.map(n => `\`/${n}\``).join(' ')
    }));

    await interaction.editReply({
        ...buildInfoContainer({
            header: `📖 Bot Help — **${mm.commands.size}** commands across **${groups.size}** modules`,
            fields,
            accent: 0x5865F2,
            footer: 'Use /help command:<name> for details about a specific command.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function showCommandDetails(interaction, ctx, name) {
    const mm = ctx.moduleManager;
    const command = mm.commands.get(name);

    if (!command) {
        const suggestions = [...mm.commands.keys()].filter(n => n.includes(name));
        await interaction.editReply({
            content: `❌ Unknown command \`/${name}\`.`,
            flags: MessageFlags.Ephemeral
        });
        if (suggestions.length > 0) {
            await interaction.followUp({
                content: `Did you mean: ${suggestions.map(s => `\`/${s}\``).join(', ')}?`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
        return;
    }

    const json = command.data.toJSON();
    const permissions = json.default_member_permissions
        ? new PermissionsBitField(BigInt(json.default_member_permissions)).toArray().join(', ')
        : 'Everyone';
    const options = (json.options ?? [])
        .map(o => `\`${o.name}\`${o.required ? ' (required)' : ''}`)
        .join(', ') || 'None';

    await interaction.editReply({
        ...buildInfoContainer({
            header: `📖 /${json.name}`,
            fields: [
                { label: 'Description', value: json.description },
                { label: 'Module', value: mm.commandModules.get(json.name) ?? 'unknown' },
                { label: 'Permissions', value: permissions },
                { label: 'Options', value: options }
            ],
            accent: 0x5865F2
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
