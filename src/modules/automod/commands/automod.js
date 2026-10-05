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
                .addUserOption(o => o.setName('user').setDescription('User to un-exempt').setRequired(true)))),

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
                { label: 'Blocked words', value: `${words.length} configured (hidden)` }
            ],
            accent: 0x5865F2,
            footer: 'Thresholds live in config.yml; toggles, words, and exemptions per server.'
        }),
        flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
    });
}
