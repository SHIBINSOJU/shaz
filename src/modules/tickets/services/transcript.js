// Real ticket transcript system: paginates the ENTIRE channel history,
// preserves author/content/timestamps/attachments/embeds/replies, and
// renders a clean Discord-style dark HTML archive.

const logger = require('../../../core/logger');
const { safePlainText, neutralizeEveryone, resolveTicketChannelName } = require('./ticketIdentity');

// Fetch EVERY message in the channel via before-pagination.
// Never caps at 100: loops until Discord returns an empty/short page.
async function fetchAllMessages(channel, { batchSize = 100, maxBatches = 200 } = {}) {
    const all = [];
    let before = undefined;
    for (let i = 0; i < maxBatches; i++) {
        const options = { limit: Math.min(100, batchSize) };
        if (before) options.before = before;
        const page = await channel.messages.fetch(options);
        if (!page || page.size === 0) break;
        const sorted = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        all.push(...sorted);
        if (page.size < options.limit) break;
        before = sorted[0].id;
        // Safety: stop if Discord keeps returning the same boundary.
        if (all.length > maxBatches * 100) break;
    }
    // De-duplicate (defensive) and sort oldest-first.
    const seen = new Set();
    const unique = [];
    for (const msg of all) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        unique.push(msg);
    }
    unique.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    return unique;
}

function escapeHtml(value) {
    return neutralizeEveryone(String(value ?? ''))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Minimal markdown subset for transcript readability (bold/italic/code).
// Mentions are intentionally NOT linkified — no ping-shaped output.
function renderMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/```([\s\S]*?)```/g, (m, code) => `<pre class="codeblock">${code}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
    out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    // Plain URLs become clickable links (http/https only).
    out = out.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return out.replace(/\n/g, '<br>');
}

function formatTime(date) {
    try {
        return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
}

function formatLong(date) {
    try {
        return new Date(date).toLocaleString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    } catch { return '—'; }
}

function messageToRecord(msg) {
    const author = msg.author || {};
    return {
        id: msg.id,
        authorId: String(author.id || msg.webhookId || 'unknown'),
        username: safePlainText(author.username || author.globalName || 'Unknown User', 100),
        displayName: safePlainText(author.displayName || author.globalName || author.username || 'Unknown User', 100),
        avatarURL: typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ size: 64 }) : null,
        bot: Boolean(author.bot),
        system: Boolean(msg.system),
        content: String(msg.content || ''),
        createdAt: msg.createdAt || new Date(msg.createdTimestamp),
        editedAt: msg.editedAt || null,
        attachments: [...(msg.attachments?.values() || [])].map((a) => ({
            name: a.name || 'attachment',
            url: a.proxyURL || a.url,
            contentType: a.contentType || '',
            size: a.size || 0,
            isImage: (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url || '')
        })),
        embeds: (msg.embeds || []).map((e) => ({
            title: e.title || '',
            description: (e.description || '').slice(0, 2000),
            url: e.url || '',
            author: e.author?.name || '',
            footer: e.footer?.text || '',
            fields: (e.fields || []).slice(0, 10).map((f) => ({ name: f.name, value: (f.value || '').slice(0, 500) })),
            image: e.image?.proxyURL || e.image?.url || '',
            thumbnail: e.thumbnail?.proxyURL || e.thumbnail?.url || ''
        })).filter((e) => e.title || e.description || e.url || e.fields.length > 0 || e.image),
        replyTo: msg.reference?.messageId
            ? {
                messageId: msg.reference.messageId,
                authorName: msg.mentions?.repliedUser?.username || null,
                authorId: msg.mentions?.repliedUser?.id || null
            }
            : null,
        stickers: [...(msg.stickers?.values() || [])].map((s) => s.name || 'sticker')
    };
}

function buildTranscriptHTML({ guild, ticket, categoryName, channelName, messages, closedBy, deletedBy, reason }) {
    const creatorName = escapeHtml(ticket.creatorDisplayName || ticket.creatorUsername || 'Unknown User');
    const creatorId = escapeHtml(ticket.userId || 'unknown');
    const ticketLabel = escapeHtml(String(channelName || `#ticket-${ticket.number}`).replace(/^#/, ''));
    const category = escapeHtml(categoryName || ticket.category || '—');
    const createdLong = formatLong(ticket.createdAt);
    const closedLong = ticket.closedAt ? formatLong(ticket.closedAt) : '—';
    const deletedLong = ticket.deletedAt ? formatLong(ticket.deletedAt) : formatLong(new Date());
    const closedByName = closedBy ? escapeHtml(closedBy.displayName || closedBy.username) : '—';
    const closedById = closedBy ? escapeHtml(closedBy.id) : '—';
    const reasonText = escapeHtml(reason || ticket.closeReason || ticket.deleteReason || ticket.reason || '—');
    const guildName = escapeHtml(guild?.name || 'Discord Server');
    const guildIcon = guild?.iconURL?.({ size: 128 }) || '';

    const messageBlocks = messages.length === 0
        ? '<div class="empty">No messages were recorded in this ticket.</div>'
        : messages.map((m) => {
            const name = escapeHtml(m.displayName || m.username);
            const uid = escapeHtml(m.authorId);
            const time = escapeHtml(formatTime(m.createdAt));
            const fullDate = escapeHtml(new Date(m.createdAt).toLocaleString());
            const edited = m.editedAt ? ` <span class="edited" title="${escapeHtml(new Date(m.editedAt).toLocaleString())}">(edited)</span>` : '';
            const tags = [
                m.bot ? '<span class="tag bot-tag">BOT</span>' : '',
                m.system ? '<span class="tag system-tag">SYSTEM</span>' : ''
            ].join(' ');
            const reply = m.replyTo
                ? `<div class="reply">↩ Replying to ${escapeHtml(m.replyTo.authorName || 'message')} (${escapeHtml(m.replyTo.authorId || m.replyTo.messageId)})</div>`
                : '';
            const body = m.content
                ? `<div class="content">${renderMarkdown(m.content)}</div>`
                : '<div class="content empty-content"><em>No text content</em></div>';
            const stickers = (m.stickers || []).map((s) => `<div class="sticker">� sticker: ${escapeHtml(s)}</div>`).join('');
            const attachments = (m.attachments || []).map((a) => {
                const aname = escapeHtml(a.name);
                const aurl = escapeHtml(a.url);
                const img = a.isImage ? `<div><a href="${aurl}" target="_blank" rel="noopener noreferrer"><img class="attachment-image" src="${aurl}" alt="${aname}" loading="lazy"></a></div>` : '';
                return `<div class="attachment"><div class="attachment-label">📎 Attachment: ${aname}</div>${img}<a class="attachment-url" href="${aurl}" target="_blank" rel="noopener noreferrer">${aurl}</a></div>`;
            }).join('');
            const embeds = (m.embeds || []).map((e) => {
                const parts = [];
                if (e.author) parts.push(`<div class="embed-author">${escapeHtml(e.author)}</div>`);
                if (e.title) parts.push(`<div class="embed-title">${e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}</div>`);
                if (e.description) parts.push(`<div class="embed-desc">${renderMarkdown(e.description.slice(0, 2000))}</div>`);
                for (const f of e.fields || []) {
                    parts.push(`<div class="embed-field"><div class="embed-field-name">${escapeHtml(f.name)}</div><div>${renderMarkdown(f.value)}</div></div>`);
                }
                if (e.image) parts.push(`<div><img class="attachment-image" src="${escapeHtml(e.image)}" loading="lazy"></div>`);
                if (e.footer) parts.push(`<div class="embed-footer">${escapeHtml(e.footer)}</div>`);
                return `<div class="embed">${parts.join('')}</div>`;
            }).join('');
            const avatar = m.avatarURL
                ? `<img class="avatar" src="${escapeHtml(m.avatarURL)}" alt="" loading="lazy" onerror="this.style.display='none'">`
                : `<div class="avatar avatar-fallback">${escapeHtml((m.displayName || m.username || '?').slice(0, 1).toUpperCase())}</div>`;
            return `<div class="message">${avatar}<div class="message-body"><div class="message-head"><span class="author">${name}</span>${tags}<span class="userid">(${uid})</span><span class="timestamp" title="${fullDate}">${time}</span>${edited}</div>${reply}${body}${stickers}${attachments}${embeds}</div></div>`;
        }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ticket #${ticket.number} Transcript — ${ticketLabel}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font-family:'gg sans','Helvetica Neue',Arial,sans-serif}
.header{background:#2b2d31;padding:28px 32px;border-bottom:1px solid #1a1b1e}
.server{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.server img{width:44px;height:44px;border-radius:50%;background:#313338}
.server-name{font-size:15px;font-weight:700;color:#fff}
.transcript-title{font-size:26px;font-weight:800;color:#fff;margin:4px 0 14px}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
.meta{background:#313338;border-radius:8px;padding:10px 14px}
.meta .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#949ba4;font-weight:700}
.meta .v{font-size:14px;color:#fff;margin-top:4px;word-break:break-word}
.timeline{max-width:900px;margin:0 auto;padding:24px 20px 60px}
.message{display:flex;gap:14px;padding:12px 8px;border-radius:8px}
.message:hover{background:#2b2d31}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
.avatar-fallback{display:flex;align-items:center;justify-content:center;background:#5865f2;color:#fff;font-weight:800;font-size:18px}
.message-body{min-width:0;flex:1}
.message-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.author{font-weight:600;color:#fff}
.userid{color:#949ba4;font-size:12px}
.timestamp{color:#949ba4;font-size:12px}
.edited{color:#949ba4;font-size:11px}
.tag{font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px}
.bot-tag{background:#5865f2;color:#fff}
.system-tag{background:#949ba4;color:#111}
.reply{color:#949ba4;font-size:12px;margin:4px 0;border-left:2px solid #4e5058;padding-left:8px}
.content{font-size:15px;line-height:1.5;word-wrap:break-word;margin-top:2px}
.empty-content{color:#949ba4}
.codeblock{background:#0d0e11;border:1px solid #4e5058;border-radius:6px;padding:10px;overflow-x:auto;font-family:Consolas,monospace;font-size:13px}
.inline-code{background:#0d0e11;padding:2px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px}
.attachment{margin-top:8px;background:#2b2d31;border:1px solid #4e5058;border-radius:8px;padding:10px}
.attachment-label{font-size:13px;color:#fff;font-weight:600}
.attachment-url{font-size:12px;color:#00a8fc;word-break:break-all}
.attachment-image{max-width:400px;max-height:300px;border-radius:8px;margin-top:8px;display:block}
.embed{margin-top:8px;background:#2b2d31;border-left:4px solid #5865f2;border-radius:4px;padding:10px 12px}
.embed-title{font-weight:700;color:#fff}
.embed-author{font-size:12px;color:#949ba4}
.embed-desc{font-size:14px;margin-top:4px}
.embed-field{margin-top:8px}.embed-field-name{font-weight:700;color:#fff;font-size:13px}
.embed-footer{font-size:12px;color:#949ba4;margin-top:8px}
.sticker{color:#949ba4;font-size:13px;margin-top:4px}
a{color:#00a8fc}
.divider{border:none;border-top:1px solid #35373c;margin:24px 0}
.footer-card{background:#2b2d31;border-radius:10px;padding:18px;margin-top:10px}
.footer-card h2{margin:0 0 10px;color:#fff;font-size:18px}
.footer-row{margin:6px 0;font-size:14px}.footer-row b{color:#fff}
.empty{color:#949ba4;text-align:center;padding:40px}
</style>
</head>
<body>
<div class="header">
<div class="server">${guildIcon ? `<img src="${escapeHtml(guildIcon)}" alt="">` : ''}<span class="server-name">${guildName}</span></div>
<div class="transcript-title">TICKET TRANSCRIPT</div>
<div class="meta-grid">
<div class="meta"><div class="k">Ticket</div><div class="v">#${ticketLabel}</div></div>
<div class="meta"><div class="k">Ticket ID</div><div class="v">#${ticket.number}</div></div>
<div class="meta"><div class="k">Category</div><div class="v">${category}</div></div>
<div class="meta"><div class="k">Creator</div><div class="v">${creatorName}<br><span style="color:#949ba4">User ID: ${creatorId}</span></div></div>
<div class="meta"><div class="k">Created</div><div class="v">${escapeHtml(createdLong)}</div></div>
<div class="meta"><div class="k">Messages</div><div class="v">${messages.length}</div></div>
</div>
</div>
<div class="timeline">
${messageBlocks}
<hr class="divider">
<div class="footer-card">
<h2>Ticket Closed</h2>
<div class="footer-row"><b>Closed By:</b> ${closedByName}</div>
<div class="footer-row"><b>User ID:</b> ${closedById}</div>
<div class="footer-row"><b>Reason:</b> ${reasonText}</div>
<div class="footer-row"><b>Closed:</b> ${escapeHtml(closedLong)}</div>
<div class="footer-row"><b>Deleted:</b> ${escapeHtml(deletedLong)}</div>
</div>
</div>
</body>
</html>`;
}

// Full pipeline: fetch channel -> paginate ALL messages -> render HTML.
// Returns { ok, buffer, filename, count } — never throws.
async function generateTranscript({ guild, channel, ticket, categoryName, closedBy, deletedBy, reason }) {
    try {
        const messages = await fetchAllMessages(channel);
        const records = messages.map(messageToRecord);
        const channelName = await resolveTicketChannelName(guild, ticket).catch(() => `#ticket-${ticket.number}`);
        const html = buildTranscriptHTML({
            guild, ticket, categoryName, channelName,
            messages: records, closedBy, deletedBy, reason
        });
        const filename = `ticket-${ticket.number}-transcript.html`;
        return { ok: true, buffer: Buffer.from(html, 'utf8'), filename, count: records.length };
    } catch (error) {
        logger.error(`Transcript generation failed for ticket #${ticket?.number}: ${error.stack || error}`);
        return { ok: false, error: error.message };
    }
}

module.exports = { fetchAllMessages, messageToRecord, buildTranscriptHTML, generateTranscript };
