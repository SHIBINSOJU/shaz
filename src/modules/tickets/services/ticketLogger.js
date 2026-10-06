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
const { withRetry, isTransientError } = require('../../../utils/retry');
const { NO_MENTIONS, safePlainText } = require('./ticketIdentity');
const { resolveTicketsConfig } = require('../config');
const configService = require('../../../core/configService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Writes the transcript buffer to a temp file and VERIFIES it before we hand
 * anything to Discord: the file must exist, be non-empty, match the buffer
 * length, and be readable back end-to-end. Throws with the real reason if any
 * check fails so the caller can keep the ticket channel.
 */
async function writeVerifiedTempTranscript(buffer) {
    const dir = path.join(os.tmpdir(), 'shaz-ticket-transcripts');
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
        dir,
        `transcript-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.html`
    );
    await fs.writeFile(tmpPath, buffer);

    const stat = await fs.stat(tmpPath);
    if (!stat.isFile() || stat.size === 0) {
        throw new Error(`temp transcript is not a readable non-empty file (size ${stat.size})`);
    }
    if (stat.size !== buffer.length) {
        throw new Error(`temp transcript size mismatch (expected ${buffer.length}, wrote ${stat.size})`);
    }
    const readBack = await fs.readFile(tmpPath);
    if (readBack.length !== buffer.length || !readBack.equals(buffer)) {
        throw new Error(`temp transcript could not be read back intact (${readBack.length}/${buffer.length} bytes)`);
    }
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
 * Reliability contract:
 *  - Rejects an empty/non-Buffer transcript up front (that is exactly what
 *    makes Discord accept a message but store NO attachment).
 *  - Verifies the on-disk file exists and is readable before uploading.
 *  - Attaches from the in-memory Buffer (not the temp path) so the multipart
 *    body never depends on a lazy re-read of the file at send time.
 *  - After sending, verifies the returned message actually carries an
 *    attachment WITH a URL and non-zero size.
 *  - Retries transient network errors and "message stored but no attachment"
 *    up to `attempts` times; 429 rate limits are waited out transparently by
 *    @discordjs/rest, so they never surface here.
 *
 * Returns { ok: true, message, attachmentUrl } only when the attachment is
 * verified present. Otherwise { ok: false, error } so the caller KEEPS the
 * ticket channel instead of deleting history. Never throws.
 */
async function sendPayloadWithTranscriptFile(channel, payload, filename, fileBuffer, { attempts = 3 } = {}) {
    const name = String(filename || 'transcript.html');

    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        const detail = !fileBuffer
            ? 'no buffer was provided'
            : !Buffer.isBuffer(fileBuffer)
                ? `expected a Buffer but got ${typeof fileBuffer}`
                : 'the transcript buffer is empty (0 bytes)';
        logger.error(`Transcript upload aborted for ${name}: ${detail}. Ticket channel kept.`);
        return { ok: false, error: 'empty-transcript' };
    }

    let tmpPath = null;
    try {
        tmpPath = await writeVerifiedTempTranscript(fileBuffer);
    } catch (error) {
        logger.error(`Transcript upload aborted for ${name}: file verification failed: ${error.message}. Ticket channel kept.`);
        await cleanupTempFile(tmpPath);
        return { ok: false, error: 'transcript-file-unreadable' };
    }

    try {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const attachment = new AttachmentBuilder(fileBuffer, {
                name,
                description: `Ticket transcript ${name}`.slice(0, 200)
            });

            let message;
            try {
                message = await channel.send({ ...payload, files: [attachment], allowedMentions: NO_MENTIONS });
            } catch (error) {
                const transient = isTransientError(error);
                logger.error(`Transcript upload send failed for ${name} (attempt ${attempt}/${attempts}, transient=${transient}): ${error.message}`);
                if (!transient || attempt === attempts) {
                    return { ok: false, error: error.message || 'upload-failed' };
                }
                await sleep(1000 * attempt);
                continue;
            }

            const attached = message?.attachments?.size
                ? [...message.attachments.values()][0]
                : null;
            if (attached && attached.url && (attached.size ?? 0) > 0) {
                logger.info(`Transcript uploaded: ${name} (message ${message.id}, ${attached.size} bytes) -> ${attached.url}`);
                return { ok: true, message, attachmentUrl: attached.url };
            }

            logger.warn(`Transcript upload attempt ${attempt}/${attempts} for ${name}: Discord accepted the message but stored no attachment.`);
            if (attempt < attempts) await sleep(1000 * attempt);
        }

        logger.error(`Transcript upload failed for ${name}: Discord stored no attachment after ${attempts} attempts. Ticket channel kept.`);
        return { ok: false, error: 'attachment-missing' };
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
