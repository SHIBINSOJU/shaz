// Discord-side management for embed builder access.
// Owner/Admin ONLY — allowed-role users may USE /embed but must never
// change who else can use it. Role IDs persist per guild in the existing
// GuildSettings model (no second permission system, no hardcoded IDs).

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { getEmbedBuilderConfig } = require('../config');
const { canConfigureEmbed, getEffectiveAllowedRoleIds } = require('../services/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('embedconfig')
        .setDescription('Manage who can use the /embed builder (owner/admin only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('role-add')
            .setDescription('Allow a role to use /embed.')
            .addRoleOption(o => o.setName('role')
                .setDescription('Role to authorize for /embed')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('role-remove')
            .setDescription('Stop a role from using /embed.')
            .addRoleOption(o => o.setName('role')
                .setDescription('Role to deauthorize')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('role-list')
            .setDescription('Show roles authorized to use /embed.')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!canConfigureEmbed(interaction)) {
            await interaction.reply({ content: '❌ Only the server owner or an administrator can configure `/embed` access.', flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            switch (sub) {
                case 'role-add': return await roleAdd(interaction);
                case 'role-remove': return await roleRemove(interaction);
                case 'role-list': return await roleList(interaction);
                default: return await interaction.editReply('❌ Unknown embedconfig subcommand.');
            }
        } catch (error) {
            logger.error(`/embedconfig ${sub} failed: ${error.stack || error}`);
            await interaction.editReply(`❌ Failed: ${error.message}`);
        }
    }
};

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

async function roleAdd(interaction) {
    requireDatabase();
    const role = interaction.options.getRole('role', true);
    if (role.id === interaction.guild.id) {
        await interaction.editReply('❌ The @everyone role cannot be added — use Administrator or ownership for broad access.');
        return;
    }
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $addToSet: { 'embed.allowedRoleIds': role.id } }
    );
    await interaction.editReply(`✅ ${role} can now use \`/embed\`.`);
}

async function roleRemove(interaction) {
    requireDatabase();
    const role = interaction.options.getRole('role', true);
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $pull: { 'embed.allowedRoleIds': role.id } }
    );
    await interaction.editReply(`✅ ${role} can no longer use \`/embed\` (unless owner/admin). File-configured roles in \`config.yml\` are unaffected — edit the file to change those.`);
}

async function roleList(interaction) {
    const builderConfig = getEmbedBuilderConfig();
    const ids = await getEffectiveAllowedRoleIds(interaction.guild, builderConfig.allowedRoleIds);
    const lines = [];
    for (const id of ids) {
        const role = await interaction.guild.roles.fetch(id).catch(() => null);
        lines.push(role ? `${role}` : `⚠️ Missing role (\`${id}\`)`);
    }
    await interaction.editReply({
        ...buildInfoContainer({
            header: '🧩 Embed Builder Access',
            fields: [
                { label: 'Server owner', value: '✅ Always allowed' },
                { label: 'Administrators', value: '✅ Always allowed' },
                { label: 'Authorized roles', value: lines.length > 0 ? lines.join(', ') : '_none — owner/admin only_' }
            ],
            accent: 0x5865F2,
            footer: 'Manage with /embedconfig role-add / role-remove (owner/admin only).'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
