const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const crypto = require('crypto');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { resolveAutoroleConfig } = require('../config');
const { checkRoleAssignable } = require('../services/autoroleService');
const { createClearSession } = require('../components/autoroleRouter');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Automatically assign roles to new members.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('enable')
            .setDescription('Enable Autorole for this server.'))
        .addSubcommand(sub => sub
            .setName('disable')
            .setDescription('Disable Autorole for this server.'))
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a role to the Autorole configuration.')
            .addRoleOption(o => o.setName('role')
                .setDescription('Role to assign to new members')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a role from Autorole (keeps it on existing members).')
            .addRoleOption(o => o.setName('role')
                .setDescription('Role to stop assigning to new members')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Show the full Autorole configuration.'))
        .addSubcommand(sub => sub
            .setName('clear')
            .setDescription('Remove all Autorole roles (asks for confirmation).'))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show a compact Autorole status overview.')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '❌ You need **Administrator** permission to manage Autorole.', flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            switch (sub) {
                case 'enable': return await setToggle(interaction, true);
                case 'disable': return await setToggle(interaction, false);
                case 'add': return await addRole(interaction);
                case 'remove': return await removeRole(interaction);
                case 'list': return await showList(interaction);
                case 'clear': return await askClear(interaction);
                case 'status': return await showStatus(interaction);
                default: return await interaction.editReply('❌ Unknown autorole subcommand.');
            }
        } catch (error) {
            logger.error(`/autorole ${sub} failed: ${error.stack || error}`);
            await interaction.editReply(`❌ Failed to update Autorole: ${error.message}`);
        }
    }
};

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

async function setToggle(interaction, enabled) {
    requireDatabase();
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'autorole.enabled': enabled } });
    await interaction.editReply(enabled
        ? '✅ **Autorole enabled** — configured roles will be assigned to new members.'
        : '✅ **Autorole disabled** — new members will not receive automatic roles.');
}

async function addRole(interaction) {
    requireDatabase();
    const role = interaction.options.getRole('role', true);

    if (role.id === interaction.guild.id) {
        await interaction.editReply('❌ The @everyone role cannot be used as an autorole.');
        return;
    }

    const check = checkRoleAssignable(interaction.guild, role);
    if (!check.ok) {
        await interaction.editReply(`❌ I cannot manage ${role} as an autorole: ${check.reason}`);
        return;
    }

    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $addToSet: { 'autorole.roles': role.id } }
    );
    await interaction.editReply({
        ...buildInfoContainer({
            header: '✅ Autorole Added',
            fields: [
                { label: 'Role', value: `${role}` },
                { label: 'Note', value: 'This role will now be assigned to new members.' }
            ],
            accent: 0x57F287
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function removeRole(interaction) {
    requireDatabase();
    const role = interaction.options.getRole('role', true);

    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $pull: { 'autorole.roles': role.id } }
    );
    await interaction.editReply({
        ...buildInfoContainer({
            header: '✅ Autorole Removed',
            fields: [
                { label: 'Role', value: `${role}` },
                { label: 'Note', value: 'Existing members keep the role — it will only stop being assigned to new members.' }
            ],
            accent: 0xFEE75C
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function resolveRoleLines(guild, roleIds) {
    const lines = [];
    for (let i = 0; i < roleIds.length; i++) {
        const stored = roleIds[i];
        const role = await guild.roles.fetch(stored).catch(() => null);
        lines.push(role ? `${i + 1}. ${role}` : `${i + 1}. _deleted role_ (\`${stored}\`)`);
    }
    return lines;
}

async function showList(interaction) {
    const config = await resolveAutoroleConfig(interaction.guild);
    const roles = [...new Set(config.roles || [])];
    const lines = await resolveRoleLines(interaction.guild, roles);

    await interaction.editReply({
        ...buildInfoContainer({
            header: '👤 Autorole Configuration',
            fields: [
                { label: 'Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Automatic Roles', value: lines.length > 0 ? lines.join('\n') : '_none configured_' },
                { label: 'Bots', value: config.bots ? '✅ Will receive autoroles' : '❌ Disabled' },
                { label: 'Delay', value: `${Math.max(0, Number(config.delay) || 0) / 1000} seconds` }
            ],
            accent: 0x5865F2
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function showStatus(interaction) {
    const config = await resolveAutoroleConfig(interaction.guild);
    const roleCount = new Set(config.roles || []).size;

    await interaction.editReply({
        ...buildInfoContainer({
            header: '👤 Autorole',
            fields: [
                { label: 'Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Roles', value: String(roleCount) },
                { label: 'Bots', value: config.bots ? '✅' : '❌' },
                { label: 'Delay', value: `${Math.max(0, Number(config.delay) || 0) / 1000}s` }
            ],
            accent: 0x5865F2
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function askClear(interaction) {
    requireDatabase();
    const config = await resolveAutoroleConfig(interaction.guild);
    if ((config.roles || []).length === 0) {
        await interaction.editReply('ℹ️ Autorole already has no configured roles — nothing to clear.');
        return;
    }

    const sessionId = crypto.randomBytes(6).toString('hex');
    createClearSession(sessionId, interaction.user.id, interaction.guild.id);

    const confirm = new ButtonBuilder()
        .setCustomId(`autorole:clear:confirm:${sessionId}`)
        .setLabel('Confirm')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Danger);
    const cancel = new ButtonBuilder()
        .setCustomId(`autorole:clear:cancel:${sessionId}`)
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary);

    const payload = buildInfoContainer({
        header: '⚠️ Are you sure?',
        fields: [
            { label: 'Warning', value: 'This will remove all configured Autorole roles.' },
            { label: 'Note', value: 'Existing members keep their roles.' }
        ],
        accent: 0xED4245
    });

    await interaction.editReply({
        ...payload,
        components: [...payload.components, new ActionRowBuilder().addComponents(confirm, cancel)],
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
