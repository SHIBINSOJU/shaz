const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType
} = require('discord.js');
const logger = require('../../../core/logger');
const guildSettingsRepository = require('../../../database/repositories/guildSettingsRepository');
const { isDatabaseReady } = require('../../../database/connection');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { canManage, MANAGE_DENY } = require('../../management/services/access');
const { RULE_NAMES, resolveAutomodConfig, invalidateAutomodConfig } = require('../config');
const { invalidateLinkConfig } = require('../services/engine');
const { ruleLabel } = require('../services/actions');

const RULE_CHOICES = [
    ['Anti-Link', 'antiLink'],
    ['Anti-Invite', 'antiInvite'],
    ['Anti-Spam', 'antiSpam'],
    ['Duplicate Messages', 'antiDuplicate'],
    ['Mention Spam', 'antiMentionSpam'],
    ['Anti-Caps', 'antiCaps'],
    ['Word Filter', 'wordFilter'],
    ['Anti-Everyone', 'antiEveryone'],
    ['Anti-Raid', 'antiRaid'],
    ['Mass Spam', 'massSpam']
];

const STATUS_EMOJI = {
    antiLink: '🔗', antiInvite: '🚫', antiSpam: '📨', antiDuplicate: '📋',
    antiMentionSpam: '📢', antiCaps: '🔠', wordFilter: '🚫', antiEveryone: '📣',
    antiRaid: '🚨', massSpam: '📨'
};

function ruleOption(option) {
    option.setName('rule').setDescription('Which rule').setRequired(true);
    for (const [name, value] of RULE_CHOICES) option.addChoices({ name, value });
    return option;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('automod')
        .setDescription('Manage the server-wide AutoMod system.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show the current AutoMod configuration.'))
        .addSubcommand(sub => sub
            .setName('enable')
            .setDescription('Enable AutoMod for this server.'))
        .addSubcommand(sub => sub
            .setName('disable')
            .setDescription('Disable AutoMod for this server.'))
        .addSubcommand(sub => sub
            .setName('config')
            .setDescription('Show thresholds, actions, exemptions, and words.'))
        .addSubcommandGroup(group => group
            .setName('rule')
            .setDescription('Enable or disable an individual rule.')
            .addSubcommand(sub => sub
                .setName('enable')
                .setDescription('Enable one rule.')
                .addStringOption(ruleOption))
            .addSubcommand(sub => sub
                .setName('disable')
                .setDescription('Disable one rule.')
                .addStringOption(ruleOption)))
        .addSubcommandGroup(group => group
            .setName('word')
            .setDescription('Manage blocked words (staff only, never shown to members).')
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Add a blocked word.')
                .addStringOption(o => o.setName('word').setDescription('Word to block').setRequired(true).setMaxLength(60)))
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Remove a blocked word.')
                .addStringOption(o => o.setName('word').setDescription('Word to unblock').setRequired(true).setMaxLength(60)))
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List blocked words.')))
        .addSubcommandGroup(group => group
            .setName('whitelist')
            .setDescription('Exempt a channel, role, or user from AutoMod.')
            .addSubcommand(sub => sub
                .setName('channel')
                .setDescription('Exempt a channel.')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to exempt').setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)))
            .addSubcommand(sub => sub
                .setName('role')
                .setDescription('Exempt a role.')
                .addRoleOption(o => o.setName('role').setDescription('Role to exempt').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('user')
                .setDescription('Exempt a user.')
                .addUserOption(o => o.setName('user').setDescription('User to exempt').setRequired(true))))
        .addSubcommandGroup(group => group
            .setName('unwhitelist')
            .setDescription('Remove an AutoMod exemption.')
            .addSubcommand(sub => sub
                .setName('channel')
                .setDescription('Remove a channel exemption.')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to un-exempt').setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)))
            .addSubcommand(sub => sub
                .setName('role')
                .setDescription('Remove a role exemption.')
                .addRoleOption(o => o.setName('role').setDescription('Role to un-exempt').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('user')
                .setDescription('Remove a user exemption.')
                .addUserOption(o => o.setName('user').setDescription('User to un-exempt').setRequired(true))))
        .addSubcommandGroup(group => group
            .setName('invite')
            .setDescription('Allow or enforce Discord invites per channel (Anti-Invite only).')
            .addSubcommand(sub => sub
                .setName('disable')
                .setDescription('Allow invites in a channel (Anti-Invite off there).')
                .addChannelOption(o => o.setName('channel').setDescription('Channel where invites are allowed').setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)))
            .addSubcommand(sub => sub
                .setName('enable')
                .setDescription('Enforce Anti-Invite in a channel again.')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to enforce again').setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)))
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List channels where invites are allowed.')))
        .addSubcommandGroup(group => group
            .setName('staff')
            .setDescription('Staff roles: fully exempt from AutoMod and Anti-Link.')
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Exempt a staff role from everything.')
                .addRoleOption(o => o.setName('role').setDescription('Staff role to exempt').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Remove a staff role exemption.')
                .addRoleOption(o => o.setName('role').setDescription('Staff role to un-exempt').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List exempt staff roles.'))),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        const access = await canManage(interaction);
        if (!access.ok) {
            await interaction.reply({ content: MANAGE_DENY, flags: MessageFlags.Ephemeral });
            return;
        }

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (!group) {
                switch (sub) {
                    case 'status': return await showStatus(interaction);
                    case 'config': return await showConfig(interaction);
                    case 'enable': return await setToggle(interaction, true);
                    case 'disable': return await setToggle(interaction, false);
                    default: return await interaction.editReply('❌ Unknown automod subcommand.');
                }
            }
            if (group === 'rule') {
                return await setRule(interaction, sub === 'enable');
            }
            if (group === 'word') {
                if (sub === 'add') return await addWord(interaction);
                if (sub === 'remove') return await removeWord(interaction);
                return await listWords(interaction);
            }
            if (group === 'whitelist' || group === 'unwhitelist') {
                return await setExemption(interaction, sub, group === 'whitelist');
            }
            if (group === 'invite') {
                if (sub === 'list') return await listInviteExceptions(interaction);
                return await setInviteException(interaction, sub === 'disable');
            }
            if (group === 'staff') {
                if (sub === 'list') return await listStaff(interaction);
                return await setStaff(interaction, sub === 'add');
            }
            return await interaction.editReply('❌ Unknown automod subcommand.');
        } catch (error) {
            logger.error(`/automod ${group ? `${group} ` : ''}${sub} failed: ${error.stack || error}`);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(`❌ Failed: ${error.message}`);
                } else {
                    await interaction.reply({ content: `❌ Failed: ${error.message}`, flags: MessageFlags.Ephemeral });
                }
            } catch {
                // Response window already closed.
            }
        }
    }
};

function requireDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('The database is not connected, so per-server settings cannot be saved. Set a valid `MONGODB_URI` and restart.');
    }
}

function touch(guildId) {
    invalidateAutomodConfig(guildId);
    invalidateLinkConfig(guildId);
}

async function setToggle(interaction, enabled) {
    requireDatabase();
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { 'automod.enabled': enabled } });
    touch(interaction.guild.id);
    await interaction.editReply(enabled
        ? '✅ **AutoMod enabled** — all enabled rules are now enforced.'
        : '✅ **AutoMod disabled** — no messages will be filtered (legacy Anti-Link listener still applies if enabled).');
}

async function setRule(interaction, enabled) {
    requireDatabase();
    const rule = interaction.options.getString('rule', true);
    if (!RULE_NAMES.includes(rule)) {
        await interaction.editReply('❌ Unknown rule.');
        return;
    }
    await guildSettingsRepository.updateGuildSettings(interaction.guild.id, { $set: { [`automod.rules.${rule}.enabled`]: enabled } });
    touch(interaction.guild.id);
    await interaction.editReply(`✅ Rule **${ruleLabel(rule)}** ${enabled ? 'enabled' : 'disabled'}.`);
}

async function addWord(interaction) {
    requireDatabase();
    const word = interaction.options.getString('word', true).trim().toLowerCase();
    if (!word) {
        await interaction.editReply('❌ Word cannot be empty.');
        return;
    }
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $addToSet: { 'automod.words': word } }
    );
    touch(interaction.guild.id);
    await interaction.editReply('✅ Blocked word added. (The word itself is never displayed.)');
}

async function removeWord(interaction) {
    requireDatabase();
    const word = interaction.options.getString('word', true).trim().toLowerCase();
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        { $pull: { 'automod.words': word } }
    );
    touch(interaction.guild.id);
    await interaction.editReply('✅ Blocked word removed (if it was present).');
}

async function listWords(interaction) {
    const config = await resolveAutomodConfig(interaction.guild);
    const count = (config.rules?.wordFilter?.words || []).length;
    await interaction.editReply(count > 0
        ? `🚫 **${count} blocked word(s)** configured. Words are hidden to prevent circumvention — use \`/automod word remove <word>\` to unblock one.`
        : '🚫 No blocked words configured. Use `/automod word add <word>` to add one.');
}

async function setExemption(interaction, kind, add) {
    requireDatabase();
    const field = kind === 'channel' ? 'automod.exemptChannels'
        : kind === 'role' ? 'automod.exemptRoles' : 'automod.exemptUsers';
    let id;
    let label;
    if (kind === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        id = channel.id;
        label = `${channel}`;
    } else if (kind === 'role') {
        const role = interaction.options.getRole('role', true);
        if (role.id === interaction.guild.id) {
            await interaction.editReply('❌ The @everyone role cannot be exempted (use per-rule settings instead).');
            return;
        }
        id = role.id;
        label = `${role}`;
    } else {
        const user = interaction.options.getUser('user', true);
        if (user.id === interaction.guild.ownerId) {
            await interaction.editReply('ℹ️ The server owner is always exempt from AutoMod.');
            return;
        }
        id = user.id;
        label = `${user}`;
    }
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        add ? { $addToSet: { [field]: id } } : { $pull: { [field]: id } }
    );
    touch(interaction.guild.id);
    await interaction.editReply(add
        ? `✅ ${label} is now exempt from AutoMod.`
        : `✅ Exemption removed for ${label}.`);
}

// Per-channel Anti-Invite exceptions: invites allowed in `disabled` channels,
// enforced everywhere else. Only the antiInvite rule is affected — every
// other rule keeps working in those channels.
async function setInviteException(interaction, disabled) {
    requireDatabase();
    const channel = interaction.options.getChannel('channel', true);
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        disabled
            ? { $addToSet: { 'automod.antiInviteDisabledChannels': channel.id } }
            : { $pull: { 'automod.antiInviteDisabledChannels': channel.id } }
    );
    touch(interaction.guild.id);
    await interaction.editReply(disabled
        ? `✅ Invites are now **allowed** in ${channel} — Anti-Invite will not act there.\n-# Note: invite links are also links — run \`/antilink channel disable\` in ${channel} as well to fully allow them.`
        : `✅ Anti-Invite **enforced** in ${channel} again — invites will be blocked there.`);
}

async function listInviteExceptions(interaction) {
    const config = await resolveAutomodConfig(interaction.guild);
    const ids = config.antiInviteDisabledChannels || [];
    await interaction.editReply(ids.length > 0
        ? `🚫 **Invites allowed in:** ${ids.map((id) => `<#${id}>`).join(', ')}`
        : '🚫 Anti-Invite is enforced in every channel. Use `/automod invite disable #channel` to allow invites somewhere.');
}

// Staff roles: exempt from EVERYTHING — the AutoMod engine and the legacy
// Anti-Link listener. Stored as the source of truth in staffRoleIds and
// mirrored into both enforcement lists (automod.exemptRoles,
// antilink.exemptRoles) so neither pipeline can touch staff.
async function setStaff(interaction, add) {
    requireDatabase();
    const role = interaction.options.getRole('role', true);
    if (role.id === interaction.guild.id) {
        await interaction.editReply('❌ The @everyone role cannot be a staff role.');
        return;
    }
    if (role.managed) {
        await interaction.editReply('❌ That role is managed by an integration and cannot be used as a staff role.');
        return;
    }
    await guildSettingsRepository.updateGuildSettings(
        interaction.guild.id,
        add
            ? {
                $addToSet: {
                    'automod.staffRoleIds': role.id,
                    'automod.exemptRoles': role.id,
                    'antilink.exemptRoles': role.id
                }
            }
            : {
                $pull: {
                    'automod.staffRoleIds': role.id,
                    'automod.exemptRoles': role.id,
                    'antilink.exemptRoles': role.id
                }
            }
    );
    touch(interaction.guild.id);
    await interaction.editReply(add
        ? `✅ ${role} is now a **staff role** — members with it bypass AutoMod and Anti-Link everywhere.`
        : `✅ ${role} is no longer a staff role.`);
}

async function listStaff(interaction) {
    const config = await resolveAutomodConfig(interaction.guild);
    const ids = config.staffRoleIds || [];
    await interaction.editReply(ids.length > 0
        ? `🛡️ **Staff roles (fully exempt):** ${ids.map((id) => `<@&${id}>`).join(', ')}`
        : '🛡️ No staff roles configured. Use `/automod staff add @role` to exempt your staff team.');
}

async function showStatus(interaction) {
    const config = await resolveAutomodConfig(interaction.guild);
    const ruleLines = RULE_NAMES.map((name) => {
        const on = config.rules?.[name]?.enabled ?? true;
        return `${STATUS_EMOJI[name] || '•'} ${ruleLabel(name)} ${on ? '🟢' : '🔴'}`;
    });
    await interaction.editReply({
        ...buildInfoContainer({
            header: '🛡️ SHAZ AUTOMOD',
            fields: [
                { label: 'System', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Rules', value: ruleLines.join('\n') },
                {
                    label: 'Actions',
                    value: [
                        `🗑️ Delete ${(config.actions?.deleteMessage ?? true) ? '🟢' : '🔴'}`,
                        `⚠️ Warning ${(config.actions?.warnUser ?? true) ? '🟢' : '🔴'}`,
                        `🔒 Timeout ${(config.actions?.timeout?.enabled ?? false) ? '🟢' : '🔴'}`
                    ].join('\n')
                }
            ],
            accent: 0x5865F2,
            footer: 'Use /automod config for thresholds, actions, exemptions, and word count.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}

async function showConfig(interaction) {
    const config = await resolveAutomodConfig(interaction.guild);
    const r = config.rules || {};
    const a = config.actions || {};
    const e = config.exemptions || {};
    const words = r.wordFilter?.words || [];
    await interaction.editReply({
        ...buildInfoContainer({
            header: '🛡️ AutoMod Configuration',
            fields: [
                { label: 'System', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled' },
                { label: 'Anti-Spam', value: `${r.antiSpam?.maxMessages ?? 5} msgs / ${r.antiSpam?.intervalSeconds ?? 5}s (warn cooldown ${r.antiSpam?.warnCooldownSeconds ?? 10}s)` },
                { label: 'Mass Spam', value: `${r.massSpam?.maxMessages ?? 10} msgs / ${r.massSpam?.intervalSeconds ?? 10}s → timeout` },
                { label: 'Duplicates', value: `${r.antiDuplicate?.maxDuplicates ?? 3} in ${r.antiDuplicate?.intervalSeconds ?? 10}s` },
                { label: 'Mentions', value: `max ${r.antiMentionSpam?.maxMentions ?? 5} per message` },
                { label: 'Caps', value: `min ${r.antiCaps?.minimumLength ?? 10} chars, ${r.antiCaps?.percentage ?? 70}% uppercase` },
                { label: 'Raid', value: `${r.antiRaid?.joins ?? 5} joins / ${r.antiRaid?.intervalSeconds ?? 10}s, lockdown ${(r.antiRaid?.lockdown ?? false) ? 'on' : 'off'}` },
                { label: 'Timeout', value: (a.timeout?.enabled ?? false) ? `🟢 ${a.timeout?.duration ?? 300}s` : '🔴 Disabled' },
                { label: 'Warn auto-delete', value: `${(a.warnDeleteDelay ?? 5000) / 1000}s` },
                { label: 'Exempt roles', value: (e.roleIds || []).map((id) => `<@&${id}>`).join(', ') || '_none_' },
                { label: 'Exempt channels', value: (e.channelIds || []).map((id) => `<#${id}>`).join(', ') || '_none_' },
                { label: 'Exempt users', value: (e.userIds || []).map((id) => `<@${id}>`).join(', ') || '_none_' },
                { label: 'Invites allowed in', value: (config.antiInviteDisabledChannels || []).map((id) => `<#${id}>`).join(', ') || '_none_ (enforced everywhere)_' },
                { label: 'Staff roles', value: (config.staffRoleIds || []).map((id) => `<@&${id}>`).join(', ') || '_none_' },
                { label: 'Blocked words', value: `${words.length} configured (hidden)` }
            ],
            accent: 0x5865F2,
            footer: 'Thresholds live in config.yml; toggles, words, and exemptions per server.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
