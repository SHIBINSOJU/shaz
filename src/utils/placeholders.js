const { smallCaps } = require('./textStyle');

function formatTimestamp(date, style = 'D') {
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function fillPlaceholders(text, member) {
    if (typeof text !== 'string' || !member) return text ?? '';

    const user = member.user ?? member;
    const guild = member.guild;
    const displayName = member.displayName ?? user.displayName ?? user.username;

    const replacements = {
        '{user}': user.toString(),
        '{username}': user.username,
        '{displayname}': displayName,
        '{userid}': user.id,
        '{mention}': user.toString(),
        '{server}': guild?.name ?? 'this server',
        '{serverid}': guild?.id ?? '',
        '{membercount}': String(guild?.memberCount ?? 0),
        '{joined}': member.joinedAt ? formatTimestamp(member.joinedAt) : 'unknown',
        '{created}': user.createdAt ? formatTimestamp(user.createdAt) : 'unknown',
        '{displaynameStyled}': smallCaps(displayName),
        '{usernameStyled}': smallCaps(user.username)
    };

    return text.replace(/\{[a-z]+\}/gi, (match) => replacements[match] ?? replacements[match.toLowerCase()] ?? match);
}

module.exports = { fillPlaceholders, formatTimestamp };
