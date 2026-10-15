// Server / moderation-adjacent logging: guild settings, invites, emojis,
// stickers, scheduled events and webhooks. Only logs information actually
// available from the gateway event or a recent audit entry — never guesses.
const { AuditLogEvent } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog } = require('../services/logDispatcher');
const { truncate, fmtTimestamp } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');

async function attribute(guild, type, targetId) {
    const entry = await fetchAuditEntry(guild, type, targetId);
    return entry ? { by: executorLine(entry), reason: entry.reason || null } : { by: null, reason: null };
}

const guildUpdate = {
    name: 'guildUpdate',
    async execute(oldGuild, newGuild) {
        try {
            const diffs = [];
            if (oldGuild.name !== newGuild.name) {
                diffs.push({ label: 'Name', value: `\`${truncate(oldGuild.name, 100)}\` → \`${truncate(newGuild.name, 100)}\`` });
            }
            const oldIcon = oldGuild.iconURL?.() || null;
            const newIcon = newGuild.iconURL?.() || null;
            if (oldIcon !== newIcon) diffs.push({ label: 'Icon', value: newIcon ? 'Updated' : 'Removed' });
            if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
                diffs.push({ label: 'Verification level', value: `${oldGuild.verificationLevel} → ${newGuild.verificationLevel}` });
            }
            if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) {
                diffs.push({ label: 'Default notifications', value: `${oldGuild.defaultMessageNotifications} → ${newGuild.defaultMessageNotifications}` });
            }
            if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) {
                diffs.push({ label: 'Content filter', value: `${oldGuild.explicitContentFilter} → ${newGuild.explicitContentFilter}` });
            }
            if (oldGuild.preferredLocale !== newGuild.preferredLocale) {
                diffs.push({ label: 'Language', value: `${oldGuild.preferredLocale} → ${newGuild.preferredLocale}` });
            }
            if ((oldGuild.description || null) !== (newGuild.description || null)) {
                diffs.push({ label: 'Description', value: truncate(newGuild.description || '_removed_', 300) });
            }
            if ((oldGuild.vanityURLCode || null) !== (newGuild.vanityURLCode || null)) {
                diffs.push({ label: 'Vanity URL', value: `${oldGuild.vanityURLCode || '_none_'} → ${newGuild.vanityURLCode || '_none_'}` });
            }
            if (diffs.length === 0) return;

            const { by } = await attribute(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
            const fields = [{ label: 'Server', value: `\`${truncate(newGuild.name, 100)}\` (\`${newGuild.id}\`)` }, ...diffs];
            if (by) fields.push({ label: 'Changed by', value: by });

            await sendLog(newGuild, 'server', {
                emoji: '⚙️',
                title: 'Server Updated',
                accent: 0x95A5A6,
                thumbnailUrl: newGuild.iconURL?.({ size: 128 }) || null,
                fields,
                footer: `Server ID: ${newGuild.id}`
            });
        } catch (error) {
            logger.error(`logs guildUpdate failed: ${error.message}`);
        }
    }
};

const inviteCreate = {
    name: 'inviteCreate',
    async execute(invite) {
        try {
            const guild = invite.guild;
            if (!guild) return;
            const fields = [
                { label: 'Code', value: `\`${invite.code}\` (discord.gg/${invite.code})` },
                { label: 'Channel', value: invite.channel ? `${invite.channel} (\`${invite.channel.id}\`)` : '_unknown_' },
                { label: 'Inviter', value: invite.inviter ? `${invite.inviter} (\`${invite.inviter.id}\`)` : '_unknown_' }
            ];
            if (invite.maxUses) fields.push({ label: 'Max uses', value: String(invite.maxUses) });
            if (invite.maxAge) fields.push({ label: 'Expires', value: fmtTimestamp(Date.now() + invite.maxAge * 1000, 'R') });
            await sendLog(guild, 'invite', {
                emoji: '📨',
                title: 'Invite Created',
                accent: 0x57F287,
                thumbnailUrl: null,
                fields,
                footer: `Code: ${invite.code}`
            });
        } catch (error) {
            logger.error(`logs inviteCreate failed: ${error.message}`);
        }
    }
};

const inviteDelete = {
    name: 'inviteDelete',
    async execute(invite) {
        try {
            const guild = invite.guild;
            if (!guild) return;
            const { by } = await attribute(guild, AuditLogEvent.InviteDelete, null);
            const fields = [
                { label: 'Code', value: `\`${invite.code}\`` },
                { label: 'Channel', value: invite.channel ? `${invite.channel} (\`${invite.channel.id}\`)` : '_unknown_' }
            ];
            if (by) fields.push({ label: 'Deleted by', value: by });
            await sendLog(guild, 'invite', {
                emoji: '📨',
                title: 'Invite Deleted',
                accent: 0xED4245,
                thumbnailUrl: null,
                fields,
                footer: `Code: ${invite.code}`
            });
        } catch (error) {
            logger.error(`logs inviteDelete failed: ${error.message}`);
        }
    }
};

function emojiEvent(name, auditType, title, emojiIcon, accent) {
    return {
        name,
        async execute(emoji) {
            try {
                const guild = emoji.guild;
                if (!guild) return;
                const { by } = await attribute(guild, auditType, emoji.id);
                const fields = [{ label: 'Emoji', value: `${emoji} \` :${emoji.name}: \` (\`${emoji.id}\`)` }];
                if (by) fields.push({ label: title.includes('Deleted') ? 'Deleted by' : title.includes('Created') ? 'Created by' : 'Updated by', value: by });
                await sendLog(guild, 'server', {
                    emoji: emojiIcon,
                    title,
                    accent,
                    thumbnailUrl: emoji.url || null,
                    fields,
                    footer: `Emoji ID: ${emoji.id}`
                });
            } catch (error) {
                logger.error(`logs ${name} failed: ${error.message}`);
            }
        }
    };
}

function stickerEvent(name, auditType, title, accent) {
    return {
        name,
        async execute(sticker) {
            try {
                const guild = sticker.guild;
                if (!guild) return;
                const { by } = await attribute(guild, auditType, sticker.id);
                const fields = [{ label: 'Sticker', value: `\`${truncate(sticker.name, 100)}\` (\`${sticker.id}\`)` }];
                if (sticker.description) fields.push({ label: 'Description', value: truncate(sticker.description, 200) });
                if (by) fields.push({ label: 'Changed by', value: by });
                await sendLog(guild, 'server', {
                    emoji: '🌟',
                    title,
                    accent,
                    thumbnailUrl: sticker.url || null,
                    fields,
                    footer: `Sticker ID: ${sticker.id}`
                });
            } catch (error) {
                logger.error(`logs ${name} failed: ${error.message}`);
            }
        }
    };
}

function scheduledEvent(name, title, emojiIcon, accent) {
    return {
        name,
        async execute(event) {
            try {
                const guild = event.guild;
                if (!guild) return;
                const fields = [
                    { label: 'Event', value: `\`${truncate(event.name, 100)}\` (\`${event.id}\`)` },
                    { label: 'Channel', value: event.channel ? `${event.channel}` : (event.entityMetadata?.location || '_external_') }
                ];
                if (event.scheduledStartTimestamp) fields.push({ label: 'Starts', value: fmtTimestamp(event.scheduledStartTimestamp) });
                if (event.creator) fields.push({ label: 'Creator', value: `${event.creator} (\`${event.creator.id}\`)` });
                await sendLog(guild, 'server', {
                    emoji: emojiIcon,
                    title,
                    accent,
                    thumbnailUrl: event.coverImageURL?.() || guild.iconURL?.({ size: 128 }) || null,
                    fields,
                    footer: `Event ID: ${event.id}`
                });
            } catch (error) {
                logger.error(`logs ${name} failed: ${error.message}`);
            }
        }
    };
}

const webhooksUpdate = {
    // discord.js emits `webhooksUpdate` (plural) for channel webhook changes.
    name: 'webhooksUpdate',
    async execute(channel) {
        try {
            const guild = channel?.guild;
            if (!guild) return;
            const entry = await fetchAuditEntry(guild, AuditLogEvent.WebhookCreate, null)
                || await fetchAuditEntry(guild, AuditLogEvent.WebhookUpdate, null)
                || await fetchAuditEntry(guild, AuditLogEvent.WebhookDelete, null);
            const fields = [
                { label: 'Channel', value: `${channel} (\`${channel.id}\`)` },
                { label: 'Change', value: 'Webhooks updated' }
            ];
            if (entry) {
                const action = entry.action === AuditLogEvent.WebhookCreate ? 'Created by'
                    : entry.action === AuditLogEvent.WebhookDelete ? 'Deleted by' : 'Updated by';
                if (executorLine(entry)) fields.push({ label: action, value: executorLine(entry) });
            }
            await sendLog(guild, 'server', {
                emoji: '🪝',
                title: 'Webhook Updated',
                accent: 0x95A5A6,
                thumbnailUrl: null,
                fields,
                footer: `Channel ID: ${channel.id}`
            });
        } catch (error) {
            logger.error(`logs webhooksUpdate failed: ${error.message}`);
        }
    }
};

module.exports = {
    guildUpdate,
    inviteCreate,
    inviteDelete,
    emojiCreate: emojiEvent('emojiCreate', AuditLogEvent.EmojiCreate, 'Emoji Created', '😀', 0x57F287),
    emojiDelete: emojiEvent('emojiDelete', AuditLogEvent.EmojiDelete, 'Emoji Deleted', '😀', 0xED4245),
    emojiUpdate: emojiEvent('emojiUpdate', AuditLogEvent.EmojiUpdate, 'Emoji Updated', '😀', 0xFEE75C),
    stickerCreate: stickerEvent('stickerCreate', AuditLogEvent.StickerCreate, 'Sticker Created', 0x57F287),
    stickerDelete: stickerEvent('stickerDelete', AuditLogEvent.StickerDelete, 'Sticker Deleted', 0xED4245),
    stickerUpdate: stickerEvent('stickerUpdate', AuditLogEvent.StickerUpdate, 'Sticker Updated', 0xFEE75C),
    guildScheduledEventCreate: scheduledEvent('guildScheduledEventCreate', 'Scheduled Event Created', '📅', 0x57F287),
    guildScheduledEventUpdate: scheduledEvent('guildScheduledEventUpdate', 'Scheduled Event Updated', '📅', 0xFEE75C),
    guildScheduledEventDelete: scheduledEvent('guildScheduledEventDelete', 'Scheduled Event Deleted', '📅', 0xED4245),
    webhooksUpdate
};
