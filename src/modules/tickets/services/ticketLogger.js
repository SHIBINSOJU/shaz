const {
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags
} = require('discord.js');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../../../core/logger');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const { withRetry } = require('../../../utils/retry');
const { NO_MENTIONS, safePlainText } = require('./ticketIdentity');
const { resolveTicketsConfig } = require('../config');
const configService = require('../../../core/configService');

async function resolveTicketLogChannel(guild) {
    let config;
    try {
        config = await resolveTicketsConfig(guild);
    } catch {
        return null;
    }
    if (!config.logs.enabled) return null;
    if (!config.logs.channelId) return null;

    // Cache first, fetch fallback. The ID stays a string end to end.
    const channelId = String(config.logs.channelId);
    let channel = guild.channels.cache.get(channelId) || null;
    if (!channel) {
        channel = await withRetry(() => guild.channels.fetch(channelId), { attempts: 2 }).catch(() => null);
    }
    if (channel && channel.isTextBased() && channel.viewable) return channel;

    // Fallback to YAML default log channel if DB override channel ID no longer exists
    const yamlLogId = String(configService.get('tickets.logs.channelId', '') || '').trim();
    if (yamlLogId && yamlLogId !== channelId) {
        let fallback = guild.channels.cache.get(yamlLogId) || null;
        if (!fallback) {
            fallback = await withRetry(() => guild.channels.fetch(yamlLogId), { attempts: 2 }).catch(() => null);
        }
        if (fallback && fallback.isTextBased() && fallback.viewable) return fallback;
    }

    if (channelId) {
        logger.warn(`Ticket logging skipped: channel ${channelId} is invalid or inaccessible.`);
    }
    return null;
}

/**
 * Sends a Components V2 ticket log entry. Never throws — logging must not
 * break the ticket flow itself.
 *
 * NO-MENTION POLICY: every log is plain text (see ticketIdentity) and is
 * sent with explicit `allowedMentions` blocking all pings.
 */
async function logTicket(guild, { title, accent = 0x5865F2, fields = [] }) {
    try {
        const channel = await resolveTicketLogChannel(guild);
        if (!channel) return false;
        const payload = buildInfoContainer({
            header: title,
            fields,
            accent,
            footer: `<t:${Math.floor(Date.now() / 1000)}:F>`
        });
        await withRetry(
            () => channel.send({ ...payload, allowedMentions: NO_MENTIONS }),
            { attempts: 2 }
        );
        return true;
    } catch (error) {
        logger.error(`Ticket logging failed: ${error.message}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// REAL transcript file attachments (discord.js v14 AttachmentBuilder).
//
// Flow per upload: HTML buffer -> temp file on disk -> AttachmentBuilder
// (built from the temp PATH, named ticket-<id>-transcript.html) ->
// channel.send({ ..., files: [attachment] }) -> VERIFY the sent message
// actually carries the attachment -> delete the temp file.
// The temp file is removed in ALL cases (success or failure).
// ---------------------------------------------------------------------------

async function writeTempTranscriptFile(filename, buffer) {
    const dir = path.join(os.tmpdir(), 'shaz-ticket-transcripts');
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
        dir,
        `transcript-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.html`
    );
    await fs.writeFile(tmpPath, buffer);
    return tmpPath;
}

async function cleanupTempFile(tmpPath) {
    if (!tmpPath) return;
    await fs.unlink(tmpPath).catch(() => {
        // Best effort — OS temp cleaners cover leftovers.
    });
}

/**
 * Sends a V2 log payload WITH the transcript as a REAL Discord file
 * attachment (native download/open UI — never a filename text lookalike).
 *
 * Returns { ok: true, message, attachmentUrl } on success. The attachment
 * presence is VERIFIED on the sent message: if Discord did not store the
 * file, this returns { ok: false, error: 'attachment-missing' } so the
 * caller keeps the ticket channel instead of deleting history.
 * Never throws.
 */
async function sendPayloadWithTranscriptFile(channel, payload, filename, fileBuffer) {
    const name = String(filename || 'transcript.html');
    let tmpPath = null;
    try {
        tmpPath = await writeTempTranscriptFile(name, fileBuffer);
        const attachment = new AttachmentBuilder(tmpPath, {
            name,
            description: `Ticket transcript ${name}`.slice(0, 200)
        });
        const message = await withRetry(
            () => channel.send({ ...payload, files: [attachment], allowedMentions: NO_MENTIONS }),
            { attempts: 2 }
        );
        const attached = message?.attachments?.size > 0
            ? [...message.attachments.values()][0]
            : null;
        if (!attached) {
            logger.error(`Transcript upload failed for ${name}: Discord accepted the message but stored no attachment.`);
            return { ok: false, error: 'attachment-missing' };
        }
        logger.info(`Transcript uploaded: ${name} (message ${message.id}, ${attached.size || '?'} bytes) -> ${attached.url}`);
        return { ok: true, message, attachmentUrl: attached.url };
    } catch (error) {
        logger.error(`Transcript upload failed for ${name}: ${error.message}`);
        return { ok: false, error: error.message || 'upload-failed' };
    } finally {
        await cleanupTempFile(tmpPath);
    }
}

/**
 * Best-effort follow-up: edits the log message to append a
 * "View Transcript" link button pointing at the REAL Discord attachment
 * URL returned by the upload. The URL always comes from the uploaded
 * message's attachment object — never fabricated. Failure is non-fatal
 * (the native file attachment is already in place).
 */
async function addViewTranscriptButton(message, payload, attachmentUrl) {
    if (!message || !attachmentUrl || !payload?.components) return false;
    try {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('📄 View Transcript')
                .setStyle(ButtonStyle.Link)
                .setURL(String(attachmentUrl))
        );
        await withRetry(
            () => message.edit({
                components: [...payload.components, row],
                allowedMentions: NO_MENTIONS,
                flags: MessageFlags.IsComponentsV2
            }),
            { attempts: 2 }
        );
        return true;
    } catch (error) {
        logger.warn(`View-transcript button could not be added (attachment itself is unaffected): ${error.message}`);
        return false;
    }
}

/**
 * Generic log entry WITH a transcript file attachment.
 * Same return contract as sendPayloadWithTranscriptFile (object, not bool).
 */
async function logTicketWithFile(guild, { title, accent = 0x5865F2, fields = [], fileBuffer, filename }) {
    try {
        const channel = await resolveTicketLogChannel(guild);
        if (!channel) return { ok: false, error: 'no-log-channel' };
        if (!fileBuffer || !filename) {
            return { ok: false, error: 'missing-transcript' };
        }
        const payload = buildInfoContainer({ header: title, fields, accent, footer: `<t:${Math.floor(Date.now() / 1000)}:F>` });
        const sent = await sendPayloadWithTranscriptFile(channel, payload, filename, fileBuffer);
        if (sent.ok) {
            await addViewTranscriptButton(sent.message, payload, sent.attachmentUrl);
        }
        return sent;
    } catch (error) {
        logger.error(`Ticket transcript upload failed: ${error.message}`);
        return { ok: false, error: error.message || 'upload-failed' };
    }
}

// ---------------------------------------------------------------------------
// 🗑️ Ticket Deleted log in the exact required format, sent TOGETHER WITH
// the real transcript file in a single message (text + files in one send,
// so the file can never be detached from its log).
// All identity lines are plain text (username + User ID) — never <@id>,
// never @everyone/@here.
// ---------------------------------------------------------------------------

function buildDeletedLogPayload(data) {
    const num = Number(data.ticketNumber);
    const channelLabel = safePlainText(String(data.channelName || `ticket-${num}`).replace(/^#/, ''), 100);
    const category = safePlainText(data.categoryName || '—', 100);
    const creator = safePlainText(data.creatorName || 'Unknown User', 100);
    const closedBy = safePlainText(data.closedByName || '—', 100);
    const deletedBy = safePlainText(data.deletedByName || 'Unknown User', 100);
    const reason = safePlainText(data.reason || '—', 1000);
    const file = safePlainText(data.filename || 'transcript.html', 100);

    const line = (t) => new TextDisplayBuilder().setContent(t);
    const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

    const container = new ContainerBuilder().setAccentColor(0xED4245);
    container.addTextDisplayComponents(line(
        `## 🗑️ Ticket Deleted\n\nTicket ID: #${num}\nTicket: #${channelLabel}\nCategory: ${category}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `Creator:\n${creator}\nUser ID: ${String(data.creatorId || 'unknown')}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `Closed By:\n${closedBy}\nUser ID: ${String(data.closedById || '—')}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `Deleted By:\n${deletedBy}\nUser ID: ${String(data.deletedById || 'unknown')}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `Reason:\n${reason}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `Created:\n${data.createdAt || '—'}\n\nClosed:\n${data.closedAt || '—'}\n\nDeleted:\n${data.deletedAt || '—'}`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `📄 Transcript attached below:\n**${file}**`
    ));
    container.addSeparatorComponents(sep());
    container.addTextDisplayComponents(line(
        `-# <t:${Math.floor(Date.now() / 1000)}:F>`
    ));

    return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

/**
 * Sends the Ticket Deleted log + real transcript file as ONE message.
 * Returns { ok: true, message, attachmentUrl } only when the log was sent
 * AND the attachment is verified present. Otherwise { ok: false, error }.
 * Never throws.
 */
async function logTicketDeletedWithTranscript(guild, data) {
    try {
        const channel = await resolveTicketLogChannel(guild);
        if (!channel) return { ok: false, error: 'no-log-channel' };
        if (!data?.fileBuffer || !data?.filename) {
            return { ok: false, error: 'missing-transcript' };
        }
        const payload = buildDeletedLogPayload(data);
        const sent = await sendPayloadWithTranscriptFile(channel, payload, data.filename, data.fileBuffer);
        if (sent.ok) {
            await addViewTranscriptButton(sent.message, payload, sent.attachmentUrl);
        }
        return sent;
    } catch (error) {
        logger.error(`Ticket deletion log failed: ${error.message}`);
        return { ok: false, error: error.message || 'log-failed' };
    }
}

module.exports = {
    logTicket,
    logTicketWithFile,
    logTicketDeletedWithTranscript,
    sendPayloadWithTranscriptFile,
    addViewTranscriptButton,
    buildDeletedLogPayload,
    resolveTicketLogChannel
};
