// Deleted-message transcript: renders a single deleted message as a clean,
// Discord-style dark HTML archive (like the ticket transcript) and returns it
// as a buffer so the message log can attach it as a file. Shows the author,
// their exact message content, channel, timing and (when the audit log proves
// it) which moderator removed it. Content is never invented — unavailable
// content is clearly labelled.

const logger = require('../../../core/logger');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        // Neutralize @everyone/@here so a transcript can never ping-shaped text.
        .replace(/@(everyone|here)/g, '@\u200b$1');
}

// Minimal markdown for readability (code/bold/italic + links). Mentions are
// intentionally left as plain text — no clickable pings.
function renderMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/```([\s\S]*?)```/g, (m, code) => `<pre class="codeblock">${code}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
    out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    out = out.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return out.replace(/\n/g, '<br>');
}

function formatLong(dateOrMs) {
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(Number(dateOrMs));
    if (!Number.isFinite(d.getTime())) return '—';
    try {
        return d.toLocaleString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit'
        });
    } catch { return '—'; }
}

/**
 * Build the deleted-message transcript HTML.
 * data: {
 *   guild, channelLabel, channelId,
 *   author: { tag, id, avatarUrl, bot },
 *   content, hasAttachments, attachments: [{ name, url }],
 *   sentAt, deletedBy, messageId
 * }
 */
function buildDeleteHTML(data) {
    const guildName = escapeHtml(data.guild?.name || 'Discord Server');
    const guildIcon = data.guild?.iconURL?.({ size: 128 }) || '';

    const authorName = escapeHtml(data.author?.tag || 'Unknown User');
    const authorId = escapeHtml(data.author?.id || 'unknown');
    const authorAvatar = data.author?.avatarUrl && String(data.author.avatarUrl).startsWith('http')
        ? `<img class="avatar" src="${escapeHtml(data.author.avatarUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="avatar avatar-fallback">${escapeHtml((data.author?.tag || '?').slice(0, 1).toUpperCase())}</div>`;
    const botTag = data.author?.bot ? '<span class="tag bot-tag">BOT</span>' : '';

    const channelLabel = data.channelLabel ? escapeHtml(data.channelLabel) : '`unknown`';
    const channelLine = `${channelLabel}${data.channelId ? ` <span class="dim">(${escapeHtml(data.channelId)})</span>` : ''}`;

    const contentBlock = data.content
        ? `<div class="content">${renderMarkdown(data.content)}</div>`
        : `<div class="content empty-content"><em>${data.hasAttachments ? 'No text content (attachments only)' : 'Content not available (message was uncached)'}</em></div>`;

    const attachments = (data.attachments || []).map((a) => {
        const aname = escapeHtml(a.name || 'attachment');
        const aurl = escapeHtml(a.url || '');
        const img = /\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url || '')
            ? `<div><a href="${aurl}" target="_blank" rel="noopener noreferrer"><img class="attachment-image" src="${aurl}" alt="${aname}" loading="lazy"></a></div>`
            : '';
        return `<div class="attachment"><div class="attachment-label">📎 Attachment: ${aname}</div>${img}<a class="attachment-url" href="${aurl}" target="_blank" rel="noopener noreferrer">${aurl}</a></div>`;
    }).join('');

    const deletedByBlock = data.deletedBy
        ? `<div class="footer-row"><b>Deleted by:</b> ${escapeHtml(data.deletedBy)}</div>`
        : `<div class="footer-row"><b>Deleted by:</b> <span class="dim">unknown (self-delete or no audit entry)</span></div>`;

    const sentLine = Number.isFinite(Number(data.sentAt)) ? formatLong(data.sentAt) : 'unknown';
    const deletedLine = formatLong(Date.now());

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deleted Message — ${authorName}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font-family:'gg sans','Helvetica Neue',Arial,sans-serif}
.header{background:#2b2d31;padding:28px 32px;border-bottom:1px solid #1a1b1e}
.server{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.server img{width:44px;height:44px;border-radius:50%;background:#313338}
.server-name{font-size:15px;font-weight:700;color:#fff}
.transcript-title{font-size:24px;font-weight:800;color:#ed4245;margin:4px 0 14px}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
.meta{background:#313338;border-radius:8px;padding:10px 14px}
.meta .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#949ba4;font-weight:700}
.meta .v{font-size:14px;color:#fff;margin-top:4px;word-break:break-word}
.dim{color:#949ba4}
.timeline{max-width:900px;margin:0 auto;padding:24px 20px 60px}
.message{display:flex;gap:14px;padding:16px 12px;border-radius:8px;background:#2b2d31;border-left:4px solid #ed4245}
.avatar{width:44px;height:44px;border-radius:50%;flex-shrink:0}
.avatar-fallback{display:flex;align-items:center;justify-content:center;background:#5865f2;color:#fff;font-weight:800;font-size:18px}
.message-body{min-width:0;flex:1}
.message-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.author{font-weight:700;color:#fff}
.userid{color:#949ba4;font-size:12px}
.tag{font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px}
.bot-tag{background:#5865f2;color:#fff}
.content{font-size:15px;line-height:1.5;word-wrap:break-word;margin-top:2px}
.empty-content{color:#949ba4}
.codeblock{background:#0d0e11;border:1px solid #4e5058;border-radius:6px;padding:10px;overflow-x:auto;font-family:Consolas,monospace;font-size:13px}
.inline-code{background:#0d0e11;padding:2px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px}
.attachment{margin-top:10px;background:#1e1f22;border:1px solid #4e5058;border-radius:8px;padding:10px}
.attachment-label{font-size:13px;color:#fff;font-weight:600}
.attachment-url{font-size:12px;color:#00a8fc;word-break:break-all}
.attachment-image{max-width:400px;max-height:300px;border-radius:8px;margin-top:8px;display:block}
a{color:#00a8fc}
.divider{border:none;border-top:1px solid #35373c;margin:24px 0}
.footer-card{background:#2b2d31;border-radius:10px;padding:18px;margin-top:10px}
.footer-card h2{margin:0 0 10px;color:#fff;font-size:18px}
.footer-row{margin:6px 0;font-size:14px}.footer-row b{color:#fff}
</style>
</head>
<body>
<div class="header">
<div class="server">${guildIcon ? `<img src="${escapeHtml(guildIcon)}" alt="">` : ''}<span class="server-name">${guildName}</span></div>
<div class="transcript-title">🗑️ DELETED MESSAGE</div>
<div class="meta-grid">
<div class="meta"><div class="k">Author</div><div class="v">${authorName}<br><span class="dim">User ID: ${authorId}</span></div></div>
<div class="meta"><div class="k">Channel</div><div class="v">${channelLine}</div></div>
<div class="meta"><div class="k">Sent</div><div class="v">${escapeHtml(sentLine)}</div></div>
<div class="meta"><div class="k">Message ID</div><div class="v">${escapeHtml(data.messageId || 'unknown')}</div></div>
</div>
</div>
<div class="timeline">
<div class="message">${authorAvatar}<div class="message-body"><div class="message-head"><span class="author">${authorName}</span>${botTag}<span class="userid">(${authorId})</span></div>${contentBlock}${attachments}</div></div>
<hr class="divider">
<div class="footer-card">
<h2>Deletion</h2>
${deletedByBlock}
<div class="footer-row"><b>Deleted:</b> ${escapeHtml(deletedLine)}</div>
</div>
</div>
</body>
</html>`;
}

// Returns { name, buffer } for the transcript attachment, or null on failure.
// Never throws — the caller can still send the embed without the file.
function generateDeleteTranscript(data) {
    try {
        const html = buildDeleteHTML(data);
        const name = `deleted-${String(data.messageId || Date.now())}.html`;
        return { name, buffer: Buffer.from(html, 'utf8') };
    } catch (error) {
        logger.error(`logs deleteTranscript failed: ${error.stack || error}`);
        return null;
    }
}

/**
 * Build a bulk-delete transcript HTML listing every purged message
 * (author + their exact content), like a mini ticket archive.
 * data: {
 *   guild, channelLabel, channelId, count, deletedBy,
 *   messages: [{ author: { tag, id, bot }, content, hasAttachments,
 *                attachments: [{ name, url }], sentAt, messageId }]
 * }
 */
function buildBulkDeleteHTML(data) {
    const guildName = escapeHtml(data.guild?.name || 'Discord Server');
    const guildIcon = data.guild?.iconURL?.({ size: 128 }) || '';
    const channelLabel = data.channelLabel ? escapeHtml(data.channelLabel) : 'unknown';
    const channelLine = `${channelLabel}${data.channelId ? ` <span class="dim">(${escapeHtml(data.channelId)})</span>` : ''}`;
    const deletedByLine = data.deletedBy
        ? escapeHtml(data.deletedBy)
        : '<span class="dim">unknown (no audit entry)</span>';

    const messages = data.messages || [];
    const blocks = messages.length === 0
        ? '<div class="empty">No recoverable message content (all were uncached).</div>'
        : messages.map((m) => {
            const name = escapeHtml(m.author?.tag || 'Unknown User');
            const uid = escapeHtml(m.author?.id || 'unknown');
            const time = Number.isFinite(Number(m.sentAt)) ? escapeHtml(formatLong(m.sentAt)) : 'unknown';
            const botTag = m.author?.bot ? '<span class="tag bot-tag">BOT</span>' : '';
            const avatar = `<div class="avatar avatar-fallback">${escapeHtml((m.author?.tag || m.author?.id || '?').slice(0, 1).toUpperCase())}</div>`;
            const body = m.content
                ? `<div class="content">${renderMarkdown(m.content)}</div>`
                : `<div class="content empty-content"><em>${m.hasAttachments ? 'No text content (attachments only)' : 'Content not available (uncached)'}</em></div>`;
            const atts = (m.attachments || []).map((a) => {
                const aurl = escapeHtml(a.url || '');
                const aname = escapeHtml(a.name || 'attachment');
                return `<div class="attachment"><div class="attachment-label">📎 ${aname}</div><a class="attachment-url" href="${aurl}" target="_blank" rel="noopener noreferrer">${aurl}</a></div>`;
            }).join('');
            return `<div class="message">${avatar}<div class="message-body"><div class="message-head"><span class="author">${name}</span>${botTag}<span class="userid">(${uid})</span><span class="timestamp">${time}</span></div>${body}${atts}</div></div>`;
        }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bulk Deleted Messages — ${channelLabel}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font-family:'gg sans','Helvetica Neue',Arial,sans-serif}
.header{background:#2b2d31;padding:28px 32px;border-bottom:1px solid #1a1b1e}
.server{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.server img{width:44px;height:44px;border-radius:50%;background:#313338}
.server-name{font-size:15px;font-weight:700;color:#fff}
.transcript-title{font-size:24px;font-weight:800;color:#ed4245;margin:4px 0 14px}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
.meta{background:#313338;border-radius:8px;padding:10px 14px}
.meta .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#949ba4;font-weight:700}
.meta .v{font-size:14px;color:#fff;margin-top:4px;word-break:break-word}
.dim{color:#949ba4}
.timeline{max-width:900px;margin:0 auto;padding:24px 20px 60px}
.message{display:flex;gap:14px;padding:12px 8px;border-radius:8px}
.message:hover{background:#2b2d31}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#5865f2;color:#fff;font-weight:800;font-size:18px}
.message-body{min-width:0;flex:1}
.message-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.author{font-weight:600;color:#fff}
.userid,.timestamp{color:#949ba4;font-size:12px}
.tag{font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px}
.bot-tag{background:#5865f2;color:#fff}
.content{font-size:15px;line-height:1.5;word-wrap:break-word;margin-top:2px}
.empty-content{color:#949ba4}
.codeblock{background:#0d0e11;border:1px solid #4e5058;border-radius:6px;padding:10px;overflow-x:auto;font-family:Consolas,monospace;font-size:13px}
.inline-code{background:#0d0e11;padding:2px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px}
.attachment{margin-top:8px;background:#2b2d31;border:1px solid #4e5058;border-radius:8px;padding:10px}
.attachment-label{font-size:13px;color:#fff;font-weight:600}
.attachment-url{font-size:12px;color:#00a8fc;word-break:break-all}
a{color:#00a8fc}
.empty{color:#949ba4;text-align:center;padding:40px}
</style>
</head>
<body>
<div class="header">
<div class="server">${guildIcon ? `<img src="${escapeHtml(guildIcon)}" alt="">` : ''}<span class="server-name">${guildName}</span></div>
<div class="transcript-title">🧹 BULK MESSAGES DELETED</div>
<div class="meta-grid">
<div class="meta"><div class="k">Channel</div><div class="v">${channelLine}</div></div>
<div class="meta"><div class="k">Messages</div><div class="v">${escapeHtml(String(data.count ?? messages.length))}</div></div>
<div class="meta"><div class="k">Deleted by</div><div class="v">${deletedByLine}</div></div>
<div class="meta"><div class="k">When</div><div class="v">${escapeHtml(formatLong(Date.now()))}</div></div>
</div>
</div>
<div class="timeline">
${blocks}
</div>
</body>
</html>`;
}

// Returns { name, buffer } for the bulk transcript, or null on failure.
function generateBulkTranscript(data) {
    try {
        const html = buildBulkDeleteHTML(data);
        const name = `bulk-deleted-${String(data.channelId || 'channel')}-${Date.now()}.html`;
        return { name, buffer: Buffer.from(html, 'utf8') };
    } catch (error) {
        logger.error(`logs bulkTranscript failed: ${error.stack || error}`);
        return null;
    }
}

module.exports = { buildDeleteHTML, generateDeleteTranscript, buildBulkDeleteHTML, generateBulkTranscript };

