// /serverstatus — publish a polished Components V2 server-status announcement
// (Online / Offline / Maintenance) to a chosen channel and notify a role.
//
// Conventions reused from this project:
// - Components V2 only (ContainerBuilder + MediaGallery), never legacy embeds,
//   built by ../services/statusAnnouncement (mirrors statusView.js).
// - Permission gate mirrors serverip.js (Administrator OR ManageGuild), plus a
//   slash-command default permission so Discord hides it from non-managers.
// - Ephemeral confirmations/errors via MessageFlags.Ephemeral; technical detail
//   goes to the shared logger, never to Discord.
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags
} = require('discord.js');
const logger = require('../../../core/logger');
const configService = require('../../../core/configService');
const { isValidStatus, buildStatusAnnouncement } = require('../services/statusAnnouncement');

// Fallback only — the real default is `minecraft.announcements.defaultRoleId`
// in config.yml so it can be changed without touching code.
const FALLBACK_ROLE_ID = '1505572426946314280';

function hasManageAccess(interaction) {
    try {
        const perms = interaction.memberPermissions;
        if (!perms) return false;
        if (perms.has(PermissionFlagsBits.Administrator)) return true;
        if (perms.has(PermissionFlagsBits.ManageGuild)) return true;
    } catch { /* treat unreadable permissions as denied */ }
    return false;
}

function statusLabel(status) {
    return { online: 'Online', offline: 'Offline', maintenance: 'Maintenance' }[status] || status;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverstatus')
        .setDescription('Publish a RISE SMP server status announcement and notify a role.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(o =>
            o.setName('status')
                .setDescription('The server status to announce')
                .setRequired(true)
                .addChoices(
                    { name: 'Online', value: 'online' },
                    { name: 'Offline', value: 'offline' },
                    { name: 'Maintenance', value: 'maintenance' }
                )
        )
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('Text channel to publish the announcement in')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addRoleOption(o =>
            o.setName('role')
                .setDescription('Role to notify (defaults to the configured announcement role)')
                .setRequired(false)
        ),

    async execute(interaction) {
        // 1-3: guard + read inputs (defer immediately; a first fetch/send can exceed 3s).
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            return;
        }
        if (!hasManageAccess(interaction)) {
            await interaction.reply({
                content: '❌ You need the **Manage Server** (or Administrator) permission to publish status announcements.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const status = interaction.options.getString('status', true);
            const channel = interaction.options.getChannel('channel', true);
            const selectedRole = interaction.options.getRole('role');

            if (!isValidStatus(status)) {
                await interaction.editReply({ content: '❌ Invalid status selected.' });
                return;
            }

            // 4: validate the channel is a text-like channel the bot can post in.
            if (!channel?.isTextBased?.()) {
                await interaction.editReply({ content: '❌ That channel cannot receive messages. Choose a text or announcement channel.' });
                return;
            }

            const guild = interaction.guild;
            const me = guild.members.me || await guild.members.fetch(guild.client.user.id).catch(() => null);
            if (!me) {
                await interaction.editReply({ content: '❌ Could not resolve my permissions in this server. Please try again.' });
                return;
            }
            const channelPerms = channel.permissionsFor(me);
            if (!channelPerms?.has(PermissionFlagsBits.ViewChannel) || !channelPerms.has(PermissionFlagsBits.SendMessages)) {
                await interaction.editReply({ content: `❌ I need **View Channel** and **Send Messages** in ${channel} to publish there.` });
                return;
            }

            // Resolve role: explicit choice, else the configured default.
            const defaultRoleId = String(configService.get('minecraft.announcements.defaultRoleId', FALLBACK_ROLE_ID) || '').trim();
            const usingDefault = !selectedRole;
            const targetRoleId = selectedRole ? selectedRole.id : defaultRoleId;

            let role = null;
            let roleMissingNote = null;
            if (targetRoleId) {
                role = guild.roles.cache.get(targetRoleId)
                    || await guild.roles.fetch(targetRoleId).catch(() => null);
                if (!role) {
                    // A deleted/invalid SELECTED role is a hard error; a missing
                    // DEFAULT just means we publish without a ping.
                    if (!usingDefault) {
                        await interaction.editReply({ content: '❌ The selected role is not valid in this server (it may have been deleted).' });
                        return;
                    }
                    roleMissingNote = 'the default announcement role no longer exists';
                }
            }

            // Warn (but still post) when the bot cannot actually ping the role:
            // role mentions need Mention Everyone unless the bot holds the role.
            let rolePingNote = null;
            if (role) {
                const canPing = channelPerms.has(PermissionFlagsBits.MentionEveryone)
                    || me.roles?.cache?.has(role.id);
                if (!canPing) {
                    rolePingNote = `I can't ping **@${role.name}** here (missing **Mention @everyone, @here, and All Roles**). The announcement posted, but members were not notified.`;
                }
            }

            // 5-6: build the Components V2 announcement (mention lives inside the container).
            const serverName = configService.get('minecraft.serverName', 'RISE SMP') || 'RISE SMP';
            const payload = buildStatusAnnouncement({
                status,
                serverName,
                roleMention: role ? role.toString() : null
            });

            // 7-8: publish it.
            await channel.send({
                flags: payload.flags,
                components: payload.components,
                allowedMentions: payload.allowedMentions
            });

            // 9: private confirmation.
            const lines = [
                '✅ **Server status announcement published successfully!**',
                `**Status:** ${statusLabel(status)}`,
                `**Channel:** ${channel}`
            ];
            if (role) lines.push(`**Role notified:** @${role.name}`);
            else if (roleMissingNote) lines.push(`**Role notified:** none (${roleMissingNote})`);
            else lines.push('**Role notified:** none');
            if (rolePingNote) lines.push(`\n⚠️ ${rolePingNote}`);

            await interaction.editReply({ content: lines.join('\n') });
        } catch (error) {
            // Never leak stack traces to Discord; log technical detail instead.
            logger.error(`/serverstatus failed: ${error?.stack || error}`);
            const code = error?.code;
            const friendly = code === 50013
                ? '❌ I lack permission to send that announcement. Check my channel/server permissions and try again.'
                : code === 40335
                    ? '❌ That message component layout was rejected by Discord. Please try again.'
                    : '❌ Could not publish the status announcement right now. Please try again in a moment.';
            try {
                await interaction.editReply({ content: friendly });
            } catch {
                // Ephemeral response window already closed.
            }
        }
    }
};
