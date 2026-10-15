// Channel + thread logging: create / delete / update (name, topic,
// category, type/settings, permission overwrites), thread lifecycle.
const { AuditLogEvent, ChannelType } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog } = require('../services/logDispatcher');
const { truncate } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');

function channelKind(channel) {
    if (channel?.isThread?.()) return 'Thread';
    switch (channel?.type) {
        case ChannelType.GuildText: return 'Text channel';
        case ChannelType.GuildVoice: return 'Voice channel';
        case ChannelType.GuildCategory: return 'Category';
        case ChannelType.GuildAnnouncement: return 'Announcement channel';
        case ChannelType.GuildStageVoice: return 'Stage channel';
        case ChannelType.GuildForum: return 'Forum channel';
        default: return 'Channel';
    }
}

function channelRef(channel) {
    if (!channel) return '_unknown_';
    return `\`#${channel.name || 'unknown'}\` (\`${channel.id}\`)`;
}

async function attribute(guild, type, targetId) {
    const entry = await fetchAuditEntry(guild, type, targetId);
    return entry ? { by: executorLine(entry), reason: entry.reason || null } : { by: null, reason: null };
}

const channelCreate = {
    name: 'channelCreate',
    async execute(channel) {
        try {
            if (!channel?.guild) return;
            if (channel.isThread?.()) return; // handled by threadCreate
            const { by } = await attribute(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
            const fields = [
                { label: channelKind(channel), value: channelRef(channel) },
                { label: 'Type', value: String(ChannelType[channel.type] || channel.type) }
            ];
            if (channel.parent) fields.push({ label: 'Category', value: `\`${channel.parent.name}\`` });
            if (by) fields.push({ label: 'Created by', value: by });
            await sendLog(channel.guild, 'channel', {
                emoji: '📺',
                title: `${channelKind(channel)} Created`,
                accent: 0x57F287,
                thumbnailUrl: null,
                fields,
                footer: `Channel ID: ${channel.id}`
            });
        } catch (error) {
            logger.error(`logs channelCreate failed: ${error.message}`);
        }
    }
};

const channelDelete = {
    name: 'channelDelete',
    async execute(channel) {
        try {
            if (!channel?.guild) return;
            if (channel.isThread?.()) return; // handled by threadDelete
            const { by } = await attribute(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
            const fields = [{ label: channelKind(channel), value: channelRef(channel) }];
            if (by) fields.push({ label: 'Deleted by', value: by });
            await sendLog(channel.guild, 'channel', {
                emoji: '🗑️',
                title: `${channelKind(channel)} Deleted`,
                accent: 0xED4245,
                thumbnailUrl: null,
                fields,
                footer: `Channel ID: ${channel.id}`
            });
        } catch (error) {
            logger.error(`logs channelDelete failed: ${error.message}`);
        }
    }
};

const channelUpdate = {
    name: 'channelUpdate',
    async execute(oldChannel, newChannel) {
        try {
            if (!newChannel?.guild) return;
            if (newChannel.isThread?.()) return;

            const diffs = [];
            if (oldChannel.name !== newChannel.name) {
                diffs.push({ label: 'Name', value: `\`${truncate(oldChannel.name, 100)}\` → \`${truncate(newChannel.name, 100)}\`` });
            }
            if ((oldChannel.topic || null) !== (newChannel.topic || null)) {
                diffs.push({
                    label: 'Topic',
                    value: `${oldChannel.topic ? truncate(oldChannel.topic, 300) : '_none_'} → ${newChannel.topic ? truncate(newChannel.topic, 300) : '_none_'}`
                });
            }
            if ((oldChannel.parentId || null) !== (newChannel.parentId || null)) {
                diffs.push({
                    label: 'Category',
                    value: `\`${oldChannel.parent?.name || 'none'}\` → \`${newChannel.parent?.name || 'none'}\``
                });
            }
            if (oldChannel.type !== newChannel.type) {
                diffs.push({ label: 'Type', value: `${String(ChannelType[oldChannel.type] || oldChannel.type)} → ${String(ChannelType[newChannel.type] || newChannel.type)}` });
            }
            if ((oldChannel.nsfw || false) !== (newChannel.nsfw || false)) {
                diffs.push({ label: 'Age-restricted', value: newChannel.nsfw ? 'Enabled' : 'Disabled' });
            }
            if ((oldChannel.rateLimitPerUser || 0) !== (newChannel.rateLimitPerUser || 0)) {
                diffs.push({ label: 'Slowmode', value: `${oldChannel.rateLimitPerUser || 0}s → ${newChannel.rateLimitPerUser || 0}s` });
            }
            if ((oldChannel.bitrate || null) !== (newChannel.bitrate || null) && newChannel.bitrate) {
                diffs.push({ label: 'Bitrate', value: `${oldChannel.bitrate} → ${newChannel.bitrate}` });
            }
            if ((oldChannel.userLimit || null) !== (newChannel.userLimit || null) && newChannel.userLimit !== undefined) {
                diffs.push({ label: 'User limit', value: `${oldChannel.userLimit || 0} → ${newChannel.userLimit || 0}` });
            }

            // Permission overwrites diff (added / removed / changed target ids).
            const oldOw = oldChannel.permissionOverwrites?.cache;
            const newOw = newChannel.permissionOverwrites?.cache;
            if (oldOw && newOw) {
                const changed = [];
                for (const [id, ow] of newOw) {
                    if (!oldOw.has(id)) changed.push(`+ <@&${id}>`);
                    else if (oldOw.get(id)?.allow?.bitfield !== ow.allow?.bitfield || oldOw.get(id)?.deny?.bitfield !== ow.deny?.bitfield) {
                        changed.push(`~ <#${newChannel.id}> target \`${id}\``);
                    }
                }
                for (const id of oldOw.keys()) {
                    if (!newOw.has(id)) changed.push(`- \`${id}\``);
                }
                if (changed.length > 0) diffs.push({ label: 'Permissions', value: truncate(changed.slice(0, 8).join('\n'), 600) });
            }

            if (diffs.length === 0) return;

            const { by } = await attribute(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
            const fields = [{ label: channelKind(newChannel), value: channelRef(newChannel) }, ...diffs];
            if (by) fields.push({ label: 'Updated by', value: by });

            await sendLog(newChannel.guild, 'channel', {
                emoji: '✏️',
                title: `${channelKind(newChannel)} Updated`,
                accent: 0xFEE75C,
                thumbnailUrl: null,
                fields,
                footer: `Channel ID: ${newChannel.id}`
            });
        } catch (error) {
            logger.error(`logs channelUpdate failed: ${error.message}`);
        }
    }
};

const threadCreate = {
    name: 'threadCreate',
    async execute(thread) {
        try {
            if (!thread?.guild) return;
            const { by } = await attribute(thread.guild, AuditLogEvent.ThreadCreate, thread.id);
            const fields = [
                { label: 'Thread', value: channelRef(thread) },
                { label: 'Parent', value: thread.parent ? channelRef(thread.parent) : '_unknown_' }
            ];
            if (by) fields.push({ label: 'Created by', value: by });
            await sendLog(thread.guild, 'message', {
                emoji: '🧵',
                title: 'Thread Created',
                accent: 0x57F287,
                thumbnailUrl: null,
                fields,
                footer: `Thread ID: ${thread.id}`
            });
        } catch (error) {
            logger.error(`logs threadCreate failed: ${error.message}`);
        }
    }
};

const threadDelete = {
    name: 'threadDelete',
    async execute(thread) {
        try {
            if (!thread?.guild) return;
            const { by } = await attribute(thread.guild, AuditLogEvent.ThreadDelete, thread.id);
            const fields = [{ label: 'Thread', value: channelRef(thread) }];
            if (by) fields.push({ label: 'Deleted by', value: by });
            await sendLog(thread.guild, 'message', {
                emoji: '🧵',
                title: 'Thread Deleted',
                accent: 0xED4245,
                thumbnailUrl: null,
                fields,
                footer: `Thread ID: ${thread.id}`
            });
        } catch (error) {
            logger.error(`logs threadDelete failed: ${error.message}`);
        }
    }
};

const threadUpdate = {
    name: 'threadUpdate',
    async execute(oldThread, newThread) {
        try {
            if (!newThread?.guild) return;
            const notes = [];
            if ((oldThread.name || null) !== (newThread.name || null)) notes.push(`Renamed to \`${truncate(newThread.name, 100)}\``);
            if ((oldThread.archived || false) !== (newThread.archived || false)) {
                notes.push(newThread.archived ? 'Archived' : 'Unarchived');
            }
            if ((oldThread.locked || false) !== (newThread.locked || false)) {
                notes.push(newThread.locked ? 'Locked' : 'Unlocked');
            }
            if (notes.length === 0) return;
            const { by } = await attribute(newThread.guild, AuditLogEvent.ThreadUpdate, newThread.id);
            const fields = [
                { label: 'Thread', value: channelRef(newThread) },
                { label: 'Change', value: notes.join(' • ') }
            ];
            if (by) fields.push({ label: 'Updated by', value: by });
            await sendLog(newThread.guild, 'message', {
                emoji: '🧵',
                title: 'Thread Updated',
                accent: 0xFEE75C,
                thumbnailUrl: null,
                fields,
                footer: `Thread ID: ${newThread.id}`
            });
        } catch (error) {
            logger.error(`logs threadUpdate failed: ${error.message}`);
        }
    }
};

module.exports = { channelCreate, channelDelete, channelUpdate, threadCreate, threadDelete, threadUpdate };
