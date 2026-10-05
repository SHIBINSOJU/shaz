// Component handlers for the management module. Three independent prefixes
// share this file; each is registered separately so prefix resolution and
// customId uniqueness follow the existing componentHandler rules:
//   announce:send:<sessionId> / announce:cancel:<sessionId>
//   poll:vote:<pollId>:<optionIndex>
//   suggest:approve:<suggestionId> / suggest:reject:<suggestionId>
const { MessageFlags } = require('discord.js');
const logger = require('../../../core/logger');
const { buildInfoContainer } = require('../../../utils/componentsV2');
const pollRepository = require('../../../database/repositories/pollRepository');
const suggestionRepository = require('../../../database/repositories/suggestionRepository');
const { getSession, consumeSession } = require('../services/announceSessions');
const { buildPollPayload } = require('../services/pollView');
const { buildSuggestionPayload } = require('../services/suggestView');
const { canReview, REVIEW_DENY } = require('../services/access');
const { fail } = require('../../utility/services/helpers');

async function ephemeral(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch {
        // Response window closed.
    }
}

const announceRouter = {
    customId: 'announce',
    async execute(interaction) {
        try {
            const [, action, sessionId] = (interaction.customId || '').split(':');
            const session = getSession(sessionId);
            if (!session || session.guildId !== interaction.guildId) {
                await ephemeral(interaction, '❌ This preview has expired. Run `/announce` again.');
                return;
            }
            if (interaction.user.id !== session.ownerId) {
                await ephemeral(interaction, '❌ Only the person who created this announcement can send it.');
                return;
            }
            if (action === 'cancel') {
                consumeSession(sessionId);
                await interaction.update({
                    ...buildInfoContainer({ header: 'Announcement cancelled.', accent: 0x808080 }),
                    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
                }).catch(() => ephemeral(interaction, 'Announcement cancelled.'));
                return;
            }
            if (action !== 'send') return;
            consumeSession(sessionId);
            const channel = await interaction.guild.channels.fetch(session.channelId).catch(() => null);
            if (!channel?.isTextBased()) {
                await ephemeral(interaction, '❌ The target channel is no longer available.');
                return;
            }
            await channel.send(session.payload);
            await interaction.update({
                ...buildInfoContainer({ header: `✅ Announcement sent in ${channel}.`, accent: 0x57F287 }),
                flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
            }).catch(() => ephemeral(interaction, `✅ Announcement sent in ${channel}.`));
        } catch (error) {
            await fail(interaction, 'announce button', error);
        }
    }
};

const pollRouter = {
    customId: 'poll',
    async execute(interaction) {
        try {
            const [, action, pollId, rawIndex] = (interaction.customId || '').split(':');
            if (action !== 'vote' || !interaction.isButton()) return;
            const poll = await pollRepository.getPoll(pollId);
            if (!poll) {
                await ephemeral(interaction, '❌ This poll no longer exists.');
                return;
            }
            if (poll.closed || (poll.endsAt && new Date(poll.endsAt) <= new Date())) {
                await ephemeral(interaction, '❌ Voting has ended for this poll.');
                return;
            }
            const updated = await pollRepository.castVote(pollId, interaction.user.id, Number(rawIndex));
            if (!updated) {
                await ephemeral(interaction, '❌ Could not record your vote. Try again.');
                return;
            }
            // Refresh the message every vote so counts stay live for everyone.
            try {
                if (interaction.message) {
                    await interaction.update(buildPollPayload(updated));
                    return;
                }
            } catch {
                // Fall through to ephemeral confirmation.
            }
            await ephemeral(interaction, `✅ Vote recorded for **${updated.options[Number(rawIndex)]?.label ?? 'your choice'}**.`);
        } catch (error) {
            await fail(interaction, 'poll vote', error);
        }
    }
};

const suggestRouter = {
    customId: 'suggest',
    async execute(interaction) {
        try {
            const [, action, suggestionId] = (interaction.customId || '').split(':');
            if ((action !== 'approve' && action !== 'reject') || !interaction.isButton()) return;
            const access = await canReview(interaction);
            if (!access.ok) {
                await ephemeral(interaction, REVIEW_DENY);
                return;
            }
            const suggestion = await suggestionRepository.getSuggestion(suggestionId);
            if (!suggestion) {
                await ephemeral(interaction, '❌ This suggestion no longer exists.');
                return;
            }
            if (suggestion.status !== 'pending') {
                await ephemeral(interaction, `❌ This suggestion was already ${suggestion.status}.`);
                return;
            }
            const status = action === 'approve' ? 'approved' : 'rejected';
            const updated = await suggestionRepository.reviewSuggestion(suggestionId, {
                status,
                reviewedBy: interaction.user.id
            });
            if (!updated) {
                await ephemeral(interaction, '❌ Could not update the suggestion. Try again.');
                return;
            }
            try {
                if (interaction.message) {
                    await interaction.update(buildSuggestionPayload(updated, interaction.user.tag));
                    return;
                }
            } catch {
                // Fall through to ephemeral confirmation.
            }
            await ephemeral(interaction, `✅ Suggestion ${status}.`);
        } catch (error) {
            await fail(interaction, 'suggest review', error);
        }
    }
};

module.exports = [announceRouter, pollRouter, suggestRouter];
