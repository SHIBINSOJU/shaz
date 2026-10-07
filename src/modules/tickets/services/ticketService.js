// Core ticket flows: creation (with duplicate + spam protection), claim,
// close, and member add/remove. Every flow re-validates guild, ticket,
// permissions, ownership, and status against MongoDB — custom IDs alone are
// never trusted. All entry points catch their own errors.

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const logger = require('../../../core/logger');
const { withRetry } = require('../../../utils/retry');
const { isDatabaseReady } = require('../../../database/connection');
const ticketRepository = require('../../../database/repositories/ticketRepository');
const { getCategory } = require('../config');
const {
    buildTicketName,
    uniqueChannelName,
    resolveStaffRoles,
    buildTicketChannelName,
    createTicketChannel
} = require('./ticketChannel');
const { buildTicketOpen } = require('./panel');
const { logTicket, logTicketWithFile, logTicketDeletedWithTranscript } = require('./ticketLogger');
const {
    safePlainText,
    resolveUserIdentity,
    resolveTicketChannelName,
    discordTimestamp,
    creatorMentionScope,
    NO_MENTIONS
} = require('./ticketIdentity');
const { generateTranscript } = require('./transcript');

const REASON_MIN = 10;
const REASON_MAX = 1000;

// Spam protection: per-user creation cooldowns + in-flight creation locks.
const lastCreationAt = new Map();
const creationsInFlight = new Set();

// Double-click protection: exactly one state-changing operation per ticket
// runs at a time. Status checks below make repeats safe; this lock makes
// them atomic (close-twice / delete-twice collapses to a single effect).
const opLocks = new Set();

function opKey(ticket) {
    return String(ticket._id || ticket.channelId);
}

async function withOpLock(ticket, fn) {
    const key = opKey(ticket);
    if (opLocks.has(key)) {
        return { ok: false, error: '⏳ This ticket is already being processed. Please wait a moment.' };
    }
    opLocks.add(key);
    try {
        return await fn();
    } finally {
        opLocks.delete(key);
    }
}

// Channel mutations (rename/move/permission edits) are strictly rate-limited
// by Discord (e.g. ~2 channel updates per 10 minutes per channel). Never let
// a queued 429 retry stall the ticket flow: bound every mutation, warn, and
// continue — the database record is authoritative and the name self-heals on
// the next state transition.
const CHANNEL_OP_TIMEOUT_MS = 8000;
async function boundedChannelOp(ticketNumber, label, promise) {
    let timer;
    try {
        await Promise.race([
            promise.catch((error) => {
                logger.warn(`Tickets: #${ticketNumber} ${label} failed: ${error.message}`);
            }),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    logger.warn(`Tickets: #${ticketNumber} ${label} timed out (rate limit?) — continuing.`);
                    resolve();
                }, CHANNEL_OP_TIMEOUT_MS);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function creationKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function checkCreationCooldown(guildId, userId, cooldownMs) {
    const now = Date.now();
    const last = lastCreationAt.get(creationKey(guildId, userId)) || 0;
    if (now - last < cooldownMs) {
        return Math.ceil((cooldownMs - (now - last)) / 1000);
    }
    return 0;
}

function validateReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return { ok: false, error: '❌ Please provide a reason for opening the ticket.' };
    if (text.length < REASON_MIN) {
        return { ok: false, error: `❌ Please explain in a bit more detail (at least ${REASON_MIN} characters).` };
    }
    if (text.length > REASON_MAX) {
        return { ok: false, error: `❌ Reason is too long (max ${REASON_MAX} characters).` };
    }
    return { ok: true, value: text };
}

function isStaffForTicket(member, ticket) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const staffIds = ticket?.staffRoleIds || [];
    if (staffIds.length > 0 && member.roles?.cache?.some?.((r) => staffIds.includes(r.id))) return true;
    return false;
}

function isStaffForCategory(member, category) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const staffIds = category?.staffRoleIds || [];
    if (staffIds.length > 0 && member.roles?.cache?.some?.((r) => staffIds.includes(r.id))) return true;
    return false;
}

function canCloseTicket({ member, ticket, config }) {
    if (isStaffForTicket(member, ticket)) return true;
    if (config.creatorCanClose && member.id === ticket.userId) return true;
    return false;
}

// Claim permission: ONLY server owner, Administrators, and configured ticket
// staff roles (by role ID). The ticket creator can NEVER claim their own
// ticket — even if they hold some other permission. Narrower than
// isStaffForTicket on purpose; other actions keep their existing checks.
function canClaimTicket({ member, ticket, guild }) {
    if (!member || !ticket) return false;
    // The creator can never claim their own ticket.
    if (String(member.id) === String(ticket.userId)) return false;
    // Server owner is always allowed.
    if (guild && String(member.id) === String(guild.ownerId)) return true;
    // Administrators are allowed.
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    // Configured ticket staff roles (Discord role IDs only, never names).
    const staffIds = ticket?.staffRoleIds || [];
    if (staffIds.length > 0 && member.roles?.cache?.some?.((r) => staffIds.includes(r.id))) return true;
    return false;
}

/**
 * Full creation flow: validate -> duplicate check -> channel -> DB record ->
 * open message -> log. On failure after channel creation, the channel is
 * removed so no orphan channels (and no partial DB records) remain.
 * Returns { ok: true, ticket, channel } or { ok: false, error }.
 */
async function createTicket({ client, guild, member, categoryKey, reason, config }) {
    const category = getCategory(config, categoryKey);
    if (!category) return { ok: false, error: '❌ That ticket category no longer exists.' };

    const reasonCheck = validateReason(reason);
    if (!reasonCheck.ok) return { ok: false, error: reasonCheck.error };

    if (!isDatabaseReady()) {
        return { ok: false, error: '❌ The database is not connected, so tickets cannot be tracked right now. Please try again later.' };
    }

    const userId = member.id;
    const lockKey = creationKey(guild.id, userId);
    if (creationsInFlight.has(lockKey)) {
        return { ok: false, error: '❌ Your ticket is already being created. Please wait a moment.' };
    }

    const waitSec = checkCreationCooldown(guild.id, userId, config.creationCooldownMs);
    if (waitSec > 0) {
        return { ok: false, error: `❌ Please wait ${waitSec}s before opening another ticket.` };
    }

    creationsInFlight.add(lockKey);
    let channel = null;
    try {
        const existing = await ticketRepository.getOpenTicketsByUser(guild.id, userId);
        // Drop ghost records: if the ticket channel was manually deleted the
        // <#id> mention renders as "unknown" and would block the user forever.
        // Stale tickets are auto-closed so the user can open a fresh one.
        const live = [];
        for (const record of existing) {
            const existingChannel = guild.channels.cache.get(record.channelId)
                || await guild.channels.fetch(record.channelId).catch(() => null);
            if (existingChannel) {
                live.push({ record, name: existingChannel.name });
            } else {
                logger.warn(`Tickets: auto-closing ghost ticket #${record.number} (${record.channelId}) — channel no longer exists.`);
                await ticketRepository.updateTicket(record._id, {
                    status: 'closed',
                    closedAt: new Date(),
                    closedBy: 'system:channel-deleted'
                }).catch(() => {});
            }
        }
        const max = config.maxOpenTicketsPerUser ?? 1;
        if (max > 0 && live.length >= max) {
            const first = live[0];
            return { ok: false, error: `❌ You already have an open ticket: <#${first.record.channelId}> (#${first.name})` };
        }

        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return { ok: false, error: '❌ I need the **Manage Channels** permission to create tickets.' };
        }

        const number = await ticketRepository.nextTicketNumber(guild.id);
        // The actual Discord username — never a nickname, never the actor.
        const baseName = buildTicketName(config.naming.format, {
            username: member.user?.username || member.displayName,
            category: categoryKey,
            number
        });
        const name = uniqueChannelName(guild, baseName);

        const { existing: categoryStaffRoles, missing } = await resolveStaffRoles(guild, category.staffRoleIds);
        if (missing.length > 0) {
            logger.warn(`Tickets: category "${categoryKey}" references missing roles: ${missing.join(', ')}`);
        }
        // Optional global support role (config `support_role_id`): mentioned
        // in the welcome message alongside category staff roles. Validated
        // against the guild like every other role — unknown IDs only warn.
        let staffRoles = [...categoryStaffRoles];
        if (config.supportRoleId) {
            const supportId = String(config.supportRoleId);
            // Cache first, fetch fallback: a cold cache must never silently
            // drop the support mention from the welcome message.
            const globalRole = guild.roles.cache.get(supportId)
                || await guild.roles.fetch(supportId).catch(() => null);
            if (globalRole && !staffRoles.some((r) => r.id === globalRole.id)) {
                staffRoles.push(globalRole);
            } else if (!globalRole) {
                logger.warn(`Tickets: configured support_role_id ${config.supportRoleId} does not exist in this server.`);
            }
        }

        channel = await withRetry(() => createTicketChannel({
            guild,
            client,
            name,
            categoryChannelId: category.categoryId,
            userId,
            staffRoles
        }), { attempts: 2 });

        const ticket = await ticketRepository.createTicket({
            guildId: guild.id,
            number,
            channelId: channel.id,
            channelName: channel.name,
            userId,
            creatorUsername: safePlainText(member.user?.username || member.displayName, 100),
            creatorDisplayName: safePlainText(member.displayName || member.user?.username, 100),
            category: categoryKey,
            reason: reasonCheck.value,
            staffRoleIds: staffRoles.map((r) => r.id),
            status: 'open'
        });

        const openPayload = buildTicketOpen(ticket.toObject ? ticket.toObject() : ticket, category);
        // NOTE: no `content` field — Discord rejects legacy fields alongside
        // MessageFlags.IsComponentsV2. allowedMentions is ALWAYS explicit:
        // ONLY the creator user + configured support roles may ping.
        // When no support role is configured, roles[] is empty and only the
        // creator is mentioned. parse[] is empty so @everyone/@here
        // (including any typed inside the ticket reason) can never fire.
        const staffIds = staffRoles.map((r) => r.id);
        const openMessage = await withRetry(
            () => channel.send({
                ...openPayload,
                allowedMentions: creatorMentionScope(userId, staffIds)
            }),
            { attempts: 2 }
        );
        await ticketRepository.updateTicket(ticket._id, {
            openMessageId: openMessage.id,
            originalParentId: channel.parentId || null
        });

        lastCreationAt.set(lockKey, Date.now());

        // Plain-text log identity — never a mention, never a ping.
        const creatorName = safePlainText(member.displayName || member.user?.username, 100);
        await logTicket(guild, {
            title: '🎫 Ticket Created',
            accent: 0x57F287,
            fields: [
                { label: 'Ticket', value: `#${channel.name}` },
                { label: 'Ticket ID', value: `#${number}` },
                { label: 'Category', value: safePlainText(category.name, 100) },
                { label: 'Creator', value: creatorName },
                { label: 'User ID', value: String(userId) },
                { label: 'Created', value: discordTimestamp(new Date()) },
                { label: 'Reason', value: safePlainText(reasonCheck.value, 1000) }
            ]
        });

        return { ok: true, ticket: ticket.toObject ? ticket.toObject() : ticket, channel };
    } catch (error) {
        logger.error(`Ticket creation failed for ${userId} in ${guild.id}: ${error.stack || error}`);
        if (channel) {
            await channel.delete('Ticket creation failed after channel setup').catch(() => {});
        }
        return { ok: false, error: `❌ Ticket creation failed: ${error.message}` };
    } finally {
        creationsInFlight.delete(lockKey);
    }
}

async function claimTicket({ guild, member, ticket, config }) {
    if (!ticket || ticket.status === 'closed' || ticket.status === 'deleted') {
        return { ok: false, error: '❌ This ticket is closed.' };
    }
    // Enforced here as well as in the handlers: manually triggering the
    // button custom ID cannot bypass the claim permission check.
    if (!canClaimTicket({ member, ticket, guild })) {
        return { ok: false, error: '❌ You cannot claim this ticket.\nOnly ticket staff and administrators can claim tickets.' };
    }
    if (ticket.claimedBy && ticket.claimedBy !== member.id && !config.allowReclaim) {
        return { ok: false, error: '❌ This ticket is already claimed.' };
    }

    return withOpLock(ticket, async () => {
        const fresh = await ticketRepository.getTicketById(ticket._id);
        if (!fresh || fresh.status === 'closed' || fresh.status === 'deleted') {
            return { ok: false, error: '❌ This ticket is closed.' };
        }
        if (fresh.claimedBy && fresh.claimedBy !== member.id && !config.allowReclaim) {
            return { ok: false, error: '❌ This ticket is already claimed.' };
        }

        const updated = await ticketRepository.updateTicket(ticket._id, {
            claimedBy: member.id,
            claimedByUsername: safePlainText(member.displayName || member.user?.username, 100),
            claimedAt: new Date(),
            status: 'claimed'
        });

        const category = getCategory(config, ticket.category);
        if (updated?.openMessageId) {
            const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
            if (channel?.isTextBased()) {
                const message = await channel.messages.fetch(updated.openMessageId).catch(() => null);
                if (message?.editable) {
                    // Edits never re-ping, but stay explicit: no new mentions.
                    await message.edit({ ...buildTicketOpen(updated, category), allowedMentions: NO_MENTIONS }).catch(() => {});
                }
            }
        }

        await logTicket(guild, {
            title: '👤 Ticket Claimed',
            accent: 0x5865F2,
            fields: [
                { label: 'Ticket ID', value: `#${ticket.number}` },
                { label: 'Ticket', value: await resolveTicketChannelName(guild, ticket) },
                { label: 'Category', value: safePlainText(category?.name || ticket.category, 100) },
                {
                    label: 'Creator',
                    value: safePlainText(ticket.creatorDisplayName || ticket.creatorUsername || ticket.userId, 100)
                },
                { label: 'Creator ID', value: String(ticket.userId) },
                {
                    label: 'Claimed By',
                    value: safePlainText(member.displayName || member.user?.username, 100)
                },
                { label: 'User ID', value: String(member.id) },
                { label: 'Claimed', value: discordTimestamp(new Date()) }
            ]
        });

        return { ok: true, ticket: updated };
    });
}

async function refreshTicketMessage(guild, ticket, config) {
    if (!ticket?.openMessageId) return;
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(ticket.openMessageId).catch(() => null);
    if (!message?.editable) return;
    const category = getCategory(config, ticket.category);
    // Edits never re-ping, but stay explicit: no new mentions.
    await message.edit({ ...buildTicketOpen(ticket, category), allowedMentions: NO_MENTIONS }).catch(() => {});
}

async function closeTicket({ client, guild, member, ticket, config }) {
    if (!ticket || ticket.status === 'closed' || ticket.status === 'deleted') {
        return { ok: false, error: '❌ This ticket is already closed.' };
    }
    if (!canCloseTicket({ member, ticket, config })) {
        return { ok: false, error: '❌ You do not have permission to close this ticket.' };
    }

    return withOpLock(ticket, async () => {
        const fresh = await ticketRepository.getTicketById(ticket._id);
        if (!fresh || fresh.status === 'closed' || fresh.status === 'deleted') {
            return { ok: false, error: '❌ This ticket is already closed.' };
        }

        const updated = await ticketRepository.updateTicket(ticket._id, {
            status: 'closed',
            closedBy: member.id,
            closedByUsername: safePlainText(member.displayName || member.user?.username, 100),
            closeReason: safePlainText(ticket.reason || '—', 1000),
            closedAt: new Date()
        });
        const category = getCategory(config, ticket.category);

        const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
        if (channel?.isTextBased()) {
            // Edit the ONE ticket message in place (open buttons become
            // Reopen/Delete) — no duplicate ticket messages are ever sent.
            await refreshTicketMessage(guild, updated || ticket, config);

            if (config.close.deleteImmediately) {
                // Archive first: generate + upload the transcript BEFORE the
                // delayed delete, so deleteImmediately never loses history.
                const closerIdentityEarly = {
                    id: String(member.id),
                    username: safePlainText(member.displayName || member.user?.username, 100),
                    displayName: safePlainText(member.displayName || member.user?.username, 100)
                };
                const autoTranscript = await generateTranscript({
                    guild,
                    channel,
                    ticket,
                    categoryName: safePlainText(category?.name || ticket.category, 100),
                    closedBy: closerIdentityEarly,
                    deletedBy: closerIdentityEarly,
                    reason: safePlainText(ticket.reason || '—', 1000)
                });
                if (autoTranscript.ok) {
                    await logTicketWithFile(guild, {
                        title: '📄 Ticket Transcript (auto-delete on close)',
                        accent: 0x5865F2,
                        fields: [
                            { label: 'Ticket ID', value: `#${ticket.number}` },
                            { label: 'Ticket', value: await resolveTicketChannelName(guild, ticket) },
                            { label: 'Transcript', value: autoTranscript.filename }
                        ],
                        fileBuffer: autoTranscript.buffer,
                        filename: autoTranscript.filename
                    });
                } else {
                    logger.error(`Auto-transcript on close failed for #${ticket.number}: ${autoTranscript.error}`);
                }
                setTimeout(() => {
                    channel.delete('Ticket closed (deleteImmediately enabled)').catch(() => {});
                }, Math.max(0, config.close.deleteDelayMs ?? 10000));
            } else {
                if (config.close.lockOnClose) {
                    await boundedChannelOp(ticket.number, 'lock creator (close)',
                        channel.permissionOverwrites.edit(ticket.userId, { SendMessages: false }));
                }
                if (config.close.closedCategoryId) {
                    const closedCategory = guild.channels.cache.get(config.close.closedCategoryId)
                        || await guild.channels.fetch(config.close.closedCategoryId).catch(() => null);
                    if (closedCategory && closedCategory.type === ChannelType.GuildCategory) {
                        if (channel.parentId !== closedCategory.id) {
                            await boundedChannelOp(ticket.number, 'move to closed category',
                                channel.setParent(closedCategory.id, { reason: 'Ticket closed' }));
                        }
                    } else {
                        logger.warn(`Tickets: closedCategoryId "${config.close.closedCategoryId}" is missing or not a category in server ${guild.id}; skipping move.`);
                    }
                }
                // Canonical name from the stored creator (ticket.userId) —
                // never from whoever clicked close, never by prefix stacking.
                const closedName = uniqueChannelName(
                    guild,
                    await buildTicketChannelName(guild, ticket, 'closed')
                );
                if (channel.name !== closedName) {
                    await boundedChannelOp(ticket.number, `rename to ${closedName}`,
                        channel.setName(closedName, 'Ticket closed'));
                }
            }
        } else {
            logger.warn(`Tickets: ticket channel ${ticket.channelId} is gone; marked closed in database.`);
        }

        const creatorIdentity = await resolveUserIdentity(guild, ticket.userId, {
            username: ticket.creatorUsername,
            displayName: ticket.creatorDisplayName
        });
        const closerName = safePlainText(member.displayName || member.user?.username, 100);
        await logTicket(guild, {
            title: '🔒 Ticket Closed',
            accent: 0xED4245,
            fields: [
                { label: 'Ticket ID', value: `#${ticket.number}` },
                { label: 'Ticket', value: await resolveTicketChannelName(guild, ticket) },
                { label: 'Category', value: safePlainText(category?.name || ticket.category, 100) },
                { label: 'Creator', value: creatorIdentity.displayName },
                { label: 'Creator ID', value: String(ticket.userId) },
                { label: 'Closed By', value: closerName },
                { label: 'Closed By ID', value: String(member.id) },
                { label: 'Reason', value: safePlainText(ticket.reason || '—', 1000) },
                { label: 'Closed', value: discordTimestamp(new Date()) }
            ]
        });

        return { ok: true, ticket: updated, deleted: config.close.deleteImmediately && !!channel };
    });
}

async function reopenTicket({ guild, member, ticket, config }) {
    if (!ticket || ticket.status !== 'closed') {
        return { ok: false, error: '❌ Only closed tickets can be reopened.' };
    }
    if (!canCloseTicket({ member, ticket, config })) {
        return { ok: false, error: '❌ You do not have permission to reopen this ticket.' };
    }

    return withOpLock(ticket, async () => {
        const fresh = await ticketRepository.getTicketById(ticket._id);
        if (!fresh || fresh.status !== 'closed') {
            return { ok: false, error: '❌ Only closed tickets can be reopened.' };
        }

        const updated = await ticketRepository.updateTicket(ticket._id, {
            status: 'open',
            closedBy: null,
            closedAt: null,
            reopenedBy: member.id,
            reopenedAt: new Date()
        });

        const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
        if (channel?.isTextBased()) {
            // Remove any legacy "Ticket Closed" notice so notices never stack.
            // (New closes no longer send a separate notice message.)
            if (ticket.statusMessageId) {
                await channel.messages.delete(ticket.statusMessageId).catch(() => {});
            }
            await ticketRepository.updateTicket(ticket._id, { statusMessageId: null }).catch(() => {});

            // Move back to the original category (category default as fallback).
            const category = getCategory(config, ticket.category);
            const homeParentId = ticket.originalParentId || category?.categoryId || null;
            if (homeParentId && channel.parentId !== homeParentId) {
                const homeCategory = guild.channels.cache.get(homeParentId)
                    || await guild.channels.fetch(homeParentId).catch(() => null);
                if (homeCategory && homeCategory.type === ChannelType.GuildCategory) {
                    await boundedChannelOp(ticket.number, 'move back to home category',
                        channel.setParent(homeCategory.id, { reason: 'Ticket reopened' }));
                } else {
                    logger.warn(`Tickets: home category "${homeParentId}" is missing or not a category in server ${guild.id}; skipping move.`);
                }
            }
            // Restore the creator's access and the canonical open name.
            await boundedChannelOp(ticket.number, 'restore creator access (reopen)',
                channel.permissionOverwrites.edit(ticket.userId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                }));
            const openName = uniqueChannelName(
                guild,
                await buildTicketChannelName(guild, ticket, 'open')
            );
            if (channel.name !== openName) {
                await boundedChannelOp(ticket.number, `rename to ${openName}`,
                    channel.setName(openName, 'Ticket reopened'));
            }

            await refreshTicketMessage(guild, updated || ticket, config);
        } else {
            logger.warn(`Tickets: ticket channel ${ticket.channelId} is gone; marked open in database.`);
        }

        await logTicket(guild, {
            title: '🔓 Ticket Reopened',
            accent: 0x57F287,
            fields: [
                { label: 'Ticket ID', value: `#${ticket.number}` },
                { label: 'Ticket', value: await resolveTicketChannelName(guild, ticket) },
                { label: 'Category', value: safePlainText(getCategory(config, ticket.category)?.name || ticket.category, 100) },
                { label: 'Creator', value: safePlainText(ticket.creatorDisplayName || ticket.creatorUsername || ticket.userId, 100) },
                { label: 'Creator ID', value: String(ticket.userId) },
                { label: 'Reopened By', value: safePlainText(member.displayName || member.user?.username, 100) },
                { label: 'Reopened By ID', value: String(member.id) }
            ]
        });

        return { ok: true, ticket: updated };
    });
}

async function destroyTicket({ guild, member, ticket, config, deleteReason }) {
    if (!ticket || ticket.status === 'deleted') {
        return { ok: false, error: '❌ This ticket no longer exists.' };
    }
    // Deletion is destructive: staff only (creators can close, not delete).
    if (!isStaffForTicket(member, ticket)) {
        return { ok: false, error: '❌ Only staff members can delete tickets.' };
    }

    return withOpLock(ticket, async () => {
        const fresh = await ticketRepository.getTicketById(ticket._id);
        if (!fresh || fresh.status === 'deleted') {
            return { ok: false, error: '❌ This ticket no longer exists.' };
        }

        const category = getCategory(config, ticket.category);
        const categoryName = safePlainText(category?.name || ticket.category, 100);
        const reason = safePlainText(deleteReason || ticket.closeReason || ticket.reason || '—', 1000);

        // ORDER OF OPERATIONS (never delete first):
        // 1. Metadata from DB. 2. Fetch ALL messages. 3. Generate transcript.
        // 4. Upload transcript to log channel. 5. Send deleted log.
        // 6. ONLY then delete the channel (caller does step 6).
        const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
        const channelName = await resolveTicketChannelName(guild, ticket);

        // Persist the deleter + channel snapshot before anything can vanish.
        const deletedAt = new Date();
        const deleterName = safePlainText(member.displayName || member.user?.username, 100);
        await ticketRepository.updateTicket(ticket._id, {
            channelName: channelName.replace(/^#/, ''),
            deletedBy: member.id,
            deletedByUsername: deleterName,
            deleteReason: reason,
            deletedAt
        }).catch(() => {});

        const creatorIdentity = await resolveUserIdentity(guild, ticket.userId, {
            username: ticket.creatorUsername,
            displayName: ticket.creatorDisplayName
        });
        const closerIdentity = ticket.closedBy
            ? await resolveUserIdentity(guild, ticket.closedBy, {
                username: ticket.closedByUsername,
                displayName: ticket.closedByUsername
            })
            : null;
        const deleterIdentity = { id: String(member.id), username: deleterName, displayName: deleterName };

        // Transcript requires a live text channel. If the channel is already
        // gone we still log (with zero messages noted) but never fail silently.
        let transcript = null;
        if (channel?.isTextBased()) {
            transcript = await generateTranscript({
                guild,
                channel,
                ticket: {
                    ...ticket,
                    channelName: channelName.replace(/^#/, ''),
                    deletedAt,
                    closedAt: ticket.closedAt || null
                },
                categoryName,
                closedBy: closerIdentity || (ticket.closedBy
                    ? { id: String(ticket.closedBy), username: ticket.closedByUsername || String(ticket.closedBy), displayName: ticket.closedByUsername || String(ticket.closedBy) }
                    : deleterIdentity),
                deletedBy: deleterIdentity,
                reason
            });
            if (!transcript.ok) {
                logger.error(`Transcript generation failed for ticket #${ticket.number}: ${transcript.error}`);
                return {
                    ok: false,
                    error: '❌ Transcript generation failed, so the ticket was NOT deleted. Please check bot permissions and try again.'
                };
            }
        } else {
            logger.warn(`Tickets: transcript skipped for #${ticket.number} — channel already gone.`);
        }

        // ONE message carrying BOTH the deletion log AND the real transcript
        // file. The upload is verified (message.attachments must be non-empty);
        // anything less aborts and the ticket channel is KEPT.
        let upload = { ok: false, error: 'missing-transcript' };
        if (transcript?.ok) {
            upload = await logTicketDeletedWithTranscript(guild, {
                ticketNumber: ticket.number,
                channelName,
                categoryName,
                creatorName: creatorIdentity.displayName,
                creatorId: String(ticket.userId),
                closedByName: closerIdentity
                    ? closerIdentity.displayName
                    : (ticket.closedByUsername ? safePlainText(ticket.closedByUsername, 100) : null),
                closedById: ticket.closedBy ? String(ticket.closedBy) : null,
                deletedByName: deleterIdentity.displayName,
                deletedById: String(member.id),
                reason,
                createdAt: discordTimestamp(ticket.createdAt),
                closedAt: discordTimestamp(ticket.closedAt),
                deletedAt: discordTimestamp(deletedAt),
                fileBuffer: transcript.buffer,
                filename: transcript.filename
            });
        } else {
            // Channel is already gone: nothing to protect, so record the
            // deletion with a plain log (no transcript possible) and mark
            // the record deleted. No channel delete is attempted.
            const loggedPlain = await logTicket(guild, {
                title: '🗑️ Ticket Deleted',
                accent: 0xED4245,
                fields: [
                    { label: 'Ticket ID', value: `#${ticket.number}` },
                    { label: 'Ticket', value: channelName },
                    { label: 'Category', value: categoryName },
                    { label: 'Creator', value: creatorIdentity.displayName },
                    { label: 'Creator ID', value: String(ticket.userId) },
                    { label: 'Deleted By', value: deleterIdentity.displayName },
                    { label: 'Deleted By ID', value: String(member.id) },
                    { label: 'Note', value: 'Channel was already deleted — no transcript available.' }
                ]
            });
            upload = loggedPlain
                ? { ok: true, attachmentUrl: null }
                : { ok: false, error: 'no-log-channel' };
        }
        if (!upload.ok) {
            const why = upload.error === 'no-log-channel'
                ? '❌ Could not write to the ticket-log channel, so the ticket was NOT deleted. Please check log channel permissions and try again.'
                : upload.error === 'missing-attach-permission'
                    ? '❌ The bot is missing the **Attach Files** permission in the ticket-log channel, so the transcript could not be uploaded and the ticket was NOT deleted. Grant that permission and try again.'
                    : upload.error === 'attachment-missing'
                        ? '❌ The transcript file did not upload to Discord, so the ticket was NOT deleted. Please try again.'
                        : upload.error === 'missing-transcript'
                            ? '❌ No transcript is available, so the ticket was NOT deleted.'
                            : `❌ Transcript/log upload failed (${upload.error}), so the ticket was NOT deleted. Please try again.`;
            logger.error(`Ticket #${ticket.number} deletion aborted (${upload.error}); channel kept.`);
            return { ok: false, error: why };
        }

        const updated = await ticketRepository.updateTicket(ticket._id, {
            status: 'deleted',
            deletedBy: member.id,
            deletedByUsername: deleterName,
            deleteReason: reason,
            deletedAt
        });

        // Two-phase delete: the caller answers the interaction FIRST and
        // deletes the channel afterwards. Deleting first would orphan the
        // interaction response (it lives in this channel).
        const liveChannel = channel || await guild.channels.fetch(ticket.channelId).catch(() => null);
        return { ok: true, ticket: updated, channel: liveChannel, transcript: transcript?.filename || null, transcriptUrl: upload.attachmentUrl || null };
    });
}

async function setMemberAccess({ guild, member, ticket, targetUserId, grant }) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isTextBased()) return { ok: false, error: '❌ The ticket channel no longer exists.' };
    if (targetUserId === ticket.userId) {
        return { ok: false, error: grant ? '❌ The ticket creator already has access.' : '❌ The ticket creator cannot be removed.' };
    }
    try {
        if (grant) {
            await channel.permissionOverwrites.edit(targetUserId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            });
        } else {
            await channel.permissionOverwrites.delete(targetUserId);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: `❌ Could not update permissions: ${error.message}` };
    }
}

// On-demand transcript: fetches ALL messages and uploads the HTML archive
// to the log channel WITHOUT deleting anything. Used by /ticket transcript.
async function sendTranscript({ guild, member, ticket, config }) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isTextBased()) return { ok: false, error: '❌ The ticket channel no longer exists.' };
    const category = getCategory(config, ticket.category);
    const categoryName = safePlainText(category?.name || ticket.category, 100);
    const requester = {
        id: String(member.id),
        username: safePlainText(member.displayName || member.user?.username, 100),
        displayName: safePlainText(member.displayName || member.user?.username, 100)
    };
    const closerIdentity = ticket.closedBy
        ? await resolveUserIdentity(guild, ticket.closedBy, {
            username: ticket.closedByUsername,
            displayName: ticket.closedByUsername
        })
        : requester;
    const result = await generateTranscript({
        guild,
        channel,
        ticket,
        categoryName,
        closedBy: closerIdentity,
        deletedBy: requester,
        reason: safePlainText(ticket.closeReason || ticket.reason || 'Manual transcript', 1000)
    });
    if (!result.ok) {
        return { ok: false, error: '❌ Transcript generation failed. Please try again.' };
    }
    const sent = await logTicketWithFile(guild, {
        title: '📄 Ticket Transcript',
        accent: 0x5865F2,
        fields: [
            { label: 'Ticket ID', value: `#${ticket.number}` },
            { label: 'Ticket', value: await resolveTicketChannelName(guild, ticket) },
            { label: 'Category', value: categoryName },
            { label: 'Requested By', value: requester.displayName },
            { label: 'Requested By ID', value: String(member.id) },
            { label: 'Messages', value: String(result.count) },
            { label: 'Transcript', value: result.filename }
        ],
        fileBuffer: result.buffer,
        filename: result.filename
    });
    if (!sent.ok) return { ok: false, error: '❌ Could not upload the transcript to the ticket-log channel.' };
    return { ok: true, filename: result.filename, count: result.count, buffer: result.buffer, attachmentUrl: sent.attachmentUrl || null };
}

// Staff-only rename: keeps the ticket prefix family intact.
async function renameTicket({ guild, member, ticket, name }) {
    const clean = safePlainText(name, 90).toLowerCase()
        .replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '-')
        .replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 90);
    if (!clean) return { ok: false, error: '❌ Please provide a valid channel name.' };
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isTextBased() || typeof channel.setName !== 'function') {
        return { ok: false, error: '❌ The ticket channel no longer exists.' };
    }
    try {
        await channel.setName(clean.slice(0, 100), `Renamed by ${member.id}`);
    } catch (error) {
        return { ok: false, error: `❌ Could not rename: ${error.message}` };
    }
    await ticketRepository.updateTicket(ticket._id, { channelName: clean }).catch(() => {});
    const renamer = safePlainText(member.displayName || member.user?.username, 100);
    await logTicket(guild, {
        title: '✏️ Ticket Renamed',
        accent: 0x5865F2,
        fields: [
            { label: 'Ticket ID', value: `#${ticket.number}` },
            { label: 'Ticket', value: `#${clean}` },
            { label: 'Renamed By', value: renamer },
            { label: 'Renamed By ID', value: String(member.id) }
        ]
    });
    return { ok: true, name: clean };
}

module.exports = {
    REASON_MIN,
    REASON_MAX,
    validateReason,
    isStaffForTicket,
    isStaffForCategory,
    canCloseTicket,
    canClaimTicket,
    createTicket,
    claimTicket,
    closeTicket,
    reopenTicket,
    destroyTicket,
    refreshTicketMessage,
    setMemberAccess,
    sendTranscript,
    renameTicket,
    checkCreationCooldown,
    _locks: { lastCreationAt, creationsInFlight }
};
