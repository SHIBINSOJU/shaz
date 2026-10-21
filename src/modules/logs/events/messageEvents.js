// Message delete / edit / bulk-delete / pin logging.
// - Uncached (partial) messages are handled safely, never inventing content:
//   the messageCache (fed by messageCreate) is consulted as a fallback.
// - Embed-preview updates (no content change) are ignored.
// - The bot never logs its own log-channel output (recursion guard).
const { AuditLogEvent } = require('discord.js');
const logger = require('../../../core/logger');
const { sendLog, isLogChannelMessage } = require('../services/logDispatcher');
const { safeContent, fmtTimestamp, userLine, avatarUrlOf, truncate } = require('../services/logBuilders');
const { fetchAuditEntry, executorLine } = require('../services/auditHelper');
const messageCache = require('../services/messageCache');
const { generateDeleteTranscript, generateBulkTranscript } = require('../services/deleteTranscript');

function channelRef(channel) {
    if (!channel) return '_unknown channel_';
    return `${channel} (\`${channel.id}\`)`;
}

function attachmentLines(attachments) {
    if (!attachments || attachments.size === 0) return null;
    return [...attachments.values()]
        .slice(0, 5)
        .map(a => `[${truncate(a.name || 'attachment', 80)}](${a.url})`)
        .join('\n');
}

const messageDelete = {
    name: 'messageDelete',
    async execute(message) {
        try {
            if (!message?.guildId) return;
            if (await isLogChannelMessage(message)) return; // recursion guard
            if (message.author?.id === message.client?.user?.id) return;

            const guild = message.guild;
            let author = message.author;
            let content = typeof message.content === 'string' && message.content.length > 0 ? message.content : null;
            let attachments = message.attachments && message.attachments.size > 0 ? message.attachments : null;

            if (message.partial) {
                try { await message.fetch().catch(() => null); } catch { /* stay partial */ }
                if (message.author) author = message.author;
                if (typeof message.content === 'string' && message.content) content = message.content;
                if (message.attachments?.size > 0) attachments = message.attachments;
            }

            // Cache fallback — clearly unavailable content is never invented.
            if ((content === null || content === '') && (!attachments || attachments.size === 0)) {
                const cached = messageCache.recall(message.id);
                if (cached && String(cached.guildId) === String(message.guildId)) {
                    content = cached.content || null;
                    if (!author && cached.authorId) {
                        author = await guild.members.fetch(cached.authorId).then(m => m.user).catch(() => null)
                            || await guild.client.users.fetch(cached.authorId).catch(() => null);
                    }
                }
            }
            messageCache.forget(message.id);

            // Attribute a moderator only when the audit log proves a bulk/single delete.
            const entry = await fetchAuditEntry(guild, AuditLogEvent.MessageDelete, author?.id || null)
                || await fetchAuditEntry(guild, AuditLogEvent.MessageBulkDelete, null);

            const fields = [
                { label: 'Author', value: author ? userLine(author) : '_unknown (uncached)_' },
                { label: 'Channel', value: message.channel ? channelRef(message.channel) : `\`${message.channelId}\`` },
                {
                    label: 'Content',
                    value: content ? safeContent(content) : (attachments?.size > 0 ? '_no text (attachments only)_' : '_content not available (uncached message)_')
                }
            ];
            const att = attachmentLines(attachments);
            if (att) fields.push({ label: 'Attachments', value: att });
            if (message.createdTimestamp) fields.push({ label: 'Sent', value: fmtTimestamp(message.createdTimestamp) });
            // Only claim moderator deletion when the audit log actually identified one.
            const modEntry = (entry && entry.extra?.channel?.id === message.channelId) ? entry : null;
            if (modEntry) fields.push({ label: 'Deleted by', value: executorLine(modEntry) });

            // Downloadable transcript file (author + their exact message), like a ticket archive.
            const attList = attachments ? [...attachments.values()].slice(0, 10).map(a => ({ name: a.name, url: a.url })) : [];
            const deletedBy = modEntry?.executor
                ? `${modEntry.executor.tag || modEntry.executor.username} (${modEntry.executor.id})`
                : null;
            const file = generateDeleteTranscript({
                guild,
                channelLabel: message.channel?.name ? `#${message.channel.name}` : null,
                channelId: message.channelId,
                author: author
                    ? { tag: author.tag || author.username, id: author.id, avatarUrl: avatarUrlOf(author), bot: Boolean(author.bot) }
                    : null,
                content,
                hasAttachments: attList.length > 0,
                attachments: attList,
                sentAt: message.createdTimestamp,
                deletedBy,
                messageId: message.id
            });

            await sendLog(guild, 'message', {
                emoji: '🗑️',
                title: 'Message Deleted',
                accent: 0xED4245,
                thumbnailUrl: author ? avatarUrlOf(author) : null,
                fields,
                footer: `Message ID: ${message.id} • Deleted: ${new Date().toISOString()}`
            }, { file: file || undefined });
        } catch (error) {
            logger.error(`logs messageDelete failed: ${error.message}`);
        }
    }
};

const messageDeleteBulk = {
    name: 'messageDeleteBulk',
    async execute(messages) {
        try {
            const first = messages.first?.();
            const guild = first?.guild;
            if (!guild) return;

            // Skip a bulk delete that only touched log channels.
            let logged = 0;
            const authors = new Map();
            const records = [];
            for (const msg of messages.values()) {
                if (String(msg.channelId) && await isLogChannelMessage(msg).catch(() => false)) continue;
                if (msg.author?.id === msg.client?.user?.id) continue;
                logged += 1;

                // Bulk events usually arrive uncached — recover content from the
                // messageCache (fed by messageCreate). Never invent text.
                const cached = messageCache.recall(msg.id);
                let author = msg.author
                    ? { tag: msg.author.tag || msg.author.username, id: msg.author.id, bot: Boolean(msg.author.bot) }
                    : null;
                let content = typeof msg.content === 'string' && msg.content ? msg.content : null;
                const sentAt = msg.createdTimestamp || null;
                const attCount = msg.attachments?.size || cached?.attachments || 0;

                if (cached && String(cached.guildId) === String(msg.guildId)) {
                    if (!content) content = cached.content || null;
                    if (!author && cached.authorId) {
                        author = { tag: cached.authorTag || cached.authorId, id: cached.authorId, bot: false };
                    }
                }

                if (author) authors.set(author.id, author.tag || author.id);
                records.push({
                    author, content,
                    hasAttachments: attCount > 0,
                    attachments: [...(msg.attachments?.values() || [])].slice(0, 5).map(a => ({ name: a.name, url: a.url })),
                    sentAt, messageId: msg.id
                });
                messageCache.forget(msg.id);
            }
            if (logged === 0) return;

            // Oldest-first for a readable archive.
            records.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));

            const channel = first.channel;
            const entry = await fetchAuditEntry(guild, AuditLogEvent.MessageBulkDelete, null);
            const by = entry ? executorLine(entry) : null;

            const fields = [
                { label: 'Channel', value: channel ? channelRef(channel) : `\`${first.channelId}\`` },
                { label: 'Messages deleted', value: String(logged) }
            ];
            if (authors.size > 0) {
                fields.push({
                    label: 'Authors',
                    value: truncate([...authors.values()].slice(0, 10).join(', '), 500)
                });
            }
            if (by) fields.push({ label: 'Deleted by', value: by });

            // Downloadable transcript of every purged message (author + content).
            const deletedBy = entry?.executor
                ? `${entry.executor.tag || entry.executor.username} (${entry.executor.id})`
                : null;
            const file = generateBulkTranscript({
                guild,
                channelLabel: channel?.name ? `#${channel.name}` : null,
                channelId: first.channelId,
                count: logged,
                deletedBy,
                messages: records
            });

            await sendLog(guild, 'message', {
                emoji: '🧹',
                title: 'Bulk Messages Deleted',
                accent: 0xED4245,
                thumbnailUrl: null,
                fields,
                footer: `${new Date().toISOString()}`
            }, { dedupKey: `bulk:${guild.id}:${first.channelId}:${Date.now() >> 13}`, file: file || undefined });
        } catch (error) {
            logger.error(`logs messageDeleteBulk failed: ${error.message}`);
        }
    }
};

const messageUpdate = {
    name: 'messageUpdate',
    async execute(oldMessage, newMessage) {
        try {
            if (!newMessage?.guildId) return;
            if (newMessage.author?.bot) return;
            if (await isLogChannelMessage(newMessage)) return;

            // Ignore embed-preview-only updates (content + attachments unchanged).
            const oldContent = typeof oldMessage?.content === 'string' ? oldMessage.content : null;
            const newContent = typeof newMessage?.content === 'string' ? newMessage.content : null;
            const oldAtt = oldMessage?.attachments?.size || 0;
            const newAtt = newMessage?.attachments?.size || 0;
            const pinFlipped = Boolean(oldMessage?.pinned) !== Boolean(newMessage?.pinned);
            const textChanged = oldContent !== newContent || oldAtt !== newAtt;
            if (!textChanged && !pinFlipped) return;

            messageCache.track(newMessage);
            const guild = newMessage.guild;

            // Pinned / unpinned (detectable via the pin flag flip).
            if (pinFlipped) {
                const pinned = Boolean(newMessage.pinned);
                const entry = await fetchAuditEntry(
                    guild, pinned ? AuditLogEvent.MessagePin : AuditLogEvent.MessageUnpin, newMessage.author?.id || null
                );
                const by = entry ? executorLine(entry) : null;
                const fields = [
                    { label: 'Author', value: newMessage.author ? userLine(newMessage.author) : '_unknown_' },
                    { label: 'Channel', value: newMessage.channel ? channelRef(newMessage.channel) : `\`${newMessage.channelId}\`` }
                ];
                if (newContent) fields.push({ label: 'Content', value: safeContent(newContent, 500) });
                if (by) fields.push({ label: pinned ? 'Pinned by' : 'Unpinned by', value: by });
                await sendLog(guild, 'message', {
                    emoji: pinned ? '📌' : '📍',
                    title: pinned ? 'Message Pinned' : 'Message Unpinned',
                    accent: 0xFEE75C,
                    thumbnailUrl: newMessage.author ? avatarUrlOf(newMessage.author) : null,
                    fields,
                    footer: `Message ID: ${newMessage.id}`
                });
                if (!textChanged) return; // pin-only change, already logged above
            }

            if (!textChanged) return;

            const fields = [
                { label: 'Author', value: newMessage.author ? userLine(newMessage.author) : '_unknown_' },
                { label: 'Channel', value: newMessage.channel ? channelRef(newMessage.channel) : `\`${newMessage.channelId}\`` },
                { label: 'Before', value: safeContent(oldContent ?? '_content not available (uncached)_') },
                { label: 'After', value: safeContent(newContent ?? '_content not available_') }
            ];
            if (newAtt !== oldAtt) {
                const att = attachmentLines(newMessage.attachments);
                fields.push({ label: 'Attachments', value: att || `${newAtt} attachment(s)` });
            }

            await sendLog(guild, 'message', {
                emoji: '✏️',
                title: 'Message Edited',
                accent: 0xFEE75C,
                thumbnailUrl: newMessage.author ? avatarUrlOf(newMessage.author) : null,
                fields,
                footer: `Message ID: ${newMessage.id} • Edited: ${new Date().toISOString()}`
            });
        } catch (error) {
            logger.error(`logs messageUpdate failed: ${error.message}`);
        }
    }
};

module.exports = { messageDelete, messageDeleteBulk, messageUpdate };
