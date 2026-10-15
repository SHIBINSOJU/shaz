// Voice state logging: join / leave / move / mute / deafen / video / stream.
// Compares oldState vs newState and emits ONE consolidated log per update.
const logger = require('../../../core/logger');
const { sendLog } = require('../services/logDispatcher');
const { fmtTimestamp, userLine, avatarUrlOf } = require('../services/logBuilders');
const { BRAND_RED } = require('../../../utils/brandColor');

function channelLabel(channel) {
    if (!channel) return '_none_';
    return `${channel} (\`${channel.name}\`)`;
}

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState) {
        try {
            const guild = newState.guild || oldState.guild;
            const member = newState.member || oldState.member;
            const user = member?.user;
            if (!guild || !member) return;

            const oldChannel = oldState.channel || null;
            const newChannel = newState.channel || null;
            const changes = [];

            if (!oldChannel && newChannel) {
                changes.push({ kind: 'join', emoji: '🔊', title: 'Member Joined Voice' });
            } else if (oldChannel && !newChannel) {
                changes.push({ kind: 'leave', emoji: '🔇', title: 'Member Left Voice' });
            } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
                changes.push({ kind: 'move', emoji: '🔀', title: 'Member Moved Voice Channels' });
            }

            if (oldState.serverMute !== newState.serverMute) {
                changes.push({
                    kind: newState.serverMute ? 'serverMuteOn' : 'serverMuteOff',
                    emoji: newState.serverMute ? '🔇' : '🔈',
                    title: newState.serverMute ? 'Member Server Muted' : 'Member Server Unmuted'
                });
            }
            if (oldState.serverDeaf !== newState.serverDeaf) {
                changes.push({
                    kind: newState.serverDeaf ? 'serverDeafOn' : 'serverDeafOff',
                    emoji: newState.serverDeaf ? '🔇' : '🔈',
                    title: newState.serverDeaf ? 'Member Server Deafened' : 'Member Server Undeafened'
                });
            }
            if (oldState.selfMute !== newState.selfMute) {
                changes.push({
                    kind: newState.selfMute ? 'selfMuteOn' : 'selfMuteOff',
                    emoji: newState.selfMute ? '🎙️' : '🎤',
                    title: newState.selfMute ? 'Member Self Muted' : 'Member Self Unmuted'
                });
            }
            if (oldState.selfDeaf !== newState.selfDeaf) {
                changes.push({
                    kind: newState.selfDeaf ? 'selfDeafOn' : 'selfDeafOff',
                    emoji: newState.selfDeaf ? '🎧' : '🔈',
                    title: newState.selfDeaf ? 'Member Self Deafened' : 'Member Self Undeafened'
                });
            }
            if (oldState.selfVideo !== newState.selfVideo) {
                changes.push({
                    kind: newState.selfVideo ? 'videoOn' : 'videoOff',
                    emoji: '📹',
                    title: newState.selfVideo ? 'Camera Enabled' : 'Camera Disabled'
                });
            }
            if (oldState.streaming !== newState.streaming) {
                changes.push({
                    kind: newState.streaming ? 'streamOn' : 'streamOff',
                    emoji: '🖥️',
                    title: newState.streaming ? 'Started Streaming' : 'Stopped Streaming'
                });
            }
            // Stage channels: suppressAudienceRequest / requestedToSpeak changes.
            if (oldState.suppress !== newState.suppress && newChannel) {
                changes.push({
                    kind: 'stage',
                    emoji: '🎭',
                    title: newState.suppress ? 'Moved to Stage Audience' : 'Invited to Stage'
                });
            }

            if (changes.length === 0) return; // unchanged state — log nothing

            const primary = changes[0];
            const fields = [
                { label: 'User', value: user ? userLine(user, member) : `\`${member.id}\`` }
            ];

            if (primary.kind === 'move') {
                fields.push({ label: 'From', value: channelLabel(oldChannel) });
                fields.push({ label: 'To', value: channelLabel(newChannel) });
            } else {
                fields.push({ label: 'Channel', value: channelLabel(newChannel || oldChannel) });
            }

            if (changes.length > 1) {
                fields.push({
                    label: 'Also changed',
                    value: changes.slice(1).map(c => c.title).join(', ')
                });
            }
            fields.push({ label: 'Time', value: fmtTimestamp(Date.now()) });

            const title = changes.length > 1 && (primary.kind === 'join' || primary.kind === 'leave' || primary.kind === 'move')
                ? `${primary.title} (+${changes.length - 1} more)`
                : changes.length > 1 ? 'Voice State Updated' : primary.title;

            await sendLog(guild, 'voice', {
                emoji: primary.emoji,
                title,
                accent: BRAND_RED,
                thumbnailUrl: user ? avatarUrlOf(user) : null,
                fields,
                footer: `ID: ${member.id}`
            });
        } catch (error) {
            logger.error(`logs voiceStateUpdate failed: ${error.message}`);
        }
    }
};
