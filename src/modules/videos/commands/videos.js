const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const logger = require('../../../core/logger');
const { getPromoConfig } = require('../services/promoConfig');
const { checkCooldown, setCooldown, formatCooldown } = require('../services/rateLimit');
const { parseYouTubeUrl, fetchVideoMetadata } = require('../services/youtube');
const { buildPromoPayload } = require('../services/promoView');
const videoPromotionRepository = require('../../../database/repositories/videoPromotionRepository');

const ROLE_DENY = '❌ You don\'t have permission to use this command. Only members with the promotion role can share videos.';

async function replyError(interaction, content) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch {
        // Response window closed — the failure is logged by the caller.
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('videos')
        .setDescription('Share a YouTube video or livestream to the promotion channel.')
        .addStringOption((option) => option
            .setName('type')
            .setDescription('Promote a normal video or a livestream')
            .setRequired(true)
            .addChoices(
                { name: 'Video', value: 'video' },
                { name: 'Live', value: 'live' }
            ))
        .addStringOption((option) => option
            .setName('link')
            .setDescription('YouTube video or livestream URL')
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await replyError(interaction, '❌ This command can only be used inside a server.');
            return;
        }

        // Deferred + ephemeral: metadata lookups can take a few seconds.
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (error) {
            logger.warn(`/videos: could not defer reply (${error?.message || error}).`);
            return;
        }

        const where = `/videos (guild ${interaction.guildId}, user ${interaction.user.id})`;
        try {
            const kind = interaction.options.getString('type', true);
            if (kind !== 'video' && kind !== 'live') {
                await interaction.editReply({ content: '❌ Invalid type. Choose **Video** or **Live**.' });
                return;
            }
            const link = interaction.options.getString('link', true);

            // 1. Role-based access (role ID only — never the role name).
            const promo = await getPromoConfig(interaction.guildId);
            if (!promo.enabled) {
                await interaction.editReply({ content: '❌ Video promotion is currently disabled.' });
                return;
            }
            if (!promo.allowedRoleId) {
                logger.warn(`${where}: youtube_promotion.allowed_role_id is missing — denying access (fail-safe).`);
                await interaction.editReply({ content: '❌ Video promotion is not configured yet. Please ask an administrator to set the promotion role.' });
                return;
            }
            let role = null;
            try {
                role = await interaction.guild.roles.fetch(promo.allowedRoleId).catch(() => null);
            } catch {
                role = null;
            }
            if (!role) {
                logger.warn(`${where}: configured allowed_role_id does not exist in this guild — denying access (fail-safe).`);
                await interaction.editReply({ content: '❌ Video promotion is misconfigured (promotion role not found). Please ask an administrator to fix it.' });
                return;
            }
            const isOwner = interaction.guild.ownerId === interaction.user.id;
            const hasRole = interaction.member?.roles?.cache?.has(promo.allowedRoleId) ?? false;
            if (!isOwner && !hasRole) {
                await interaction.editReply({ content: ROLE_DENY });
                return;
            }

            // 2. URL validation + normalization.
            const parsed = parseYouTubeUrl(link);
            if (!parsed.ok) {
                await interaction.editReply({ content: parsed.reason });
                return;
            }

            // 3. Per-user cooldown (applied before the slow metadata lookup so
            // rapid double-submits cannot both pass).
            const cooldown = checkCooldown(interaction.guildId, interaction.user.id, promo.cooldownSeconds);
            if (cooldown.limited) {
                await interaction.editReply({
                    content: `⏳ You're sharing too fast. Please wait **${formatCooldown(cooldown.retryAfterSec)}** before promoting again.`
                });
                return;
            }

            // 4. Duplicate protection: same member + same video within the window.
            if (promo.duplicateCooldownSeconds > 0) {
                const existing = await videoPromotionRepository.findRecentPromotion(
                    interaction.guildId, interaction.user.id, parsed.videoId, promo.duplicateCooldownSeconds
                );
                if (existing) {
                    await interaction.editReply({
                        content: `⚠️ You've already promoted this video recently. Please wait **${formatCooldown(promo.duplicateCooldownSeconds)}** between re-promoting the same video.`
                    });
                    return;
                }
            }

            // 5. Destination channel + bot permissions.
            if (!promo.channelId) {
                logger.warn(`${where}: youtube_promotion.channel_id is missing.`);
                await interaction.editReply({ content: '❌ No promotion channel is configured yet. Please ask an administrator to set one.' });
                return;
            }
            const channel = await interaction.guild.channels.fetch(promo.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                logger.warn(`${where}: promotion channel ${promo.channelId} not found or not text-based.`);
                await interaction.editReply({ content: '❌ The promotion channel could not be found. Please ask an administrator to check the configuration.' });
                return;
            }
            const me = interaction.guild.members.me;
            const perms = me ? channel.permissionsFor(me) : null;
            if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
                logger.warn(`${where}: missing Send Messages permission in channel ${channel.id}.`);
                await interaction.editReply({ content: '❌ I don\'t have permission to post in the promotion channel. Please ask an administrator to grant me **Send Messages** access.' });
                return;
            }
            if (!perms.has(PermissionFlagsBits.EmbedLinks)) {
                logger.warn(`${where}: missing Embed Links permission in channel ${channel.id}.`);
                await interaction.editReply({ content: '❌ I need the **Embed Links** permission in the promotion channel to post promotions.' });
                return;
            }

            setCooldown(interaction.guildId, interaction.user.id);

            // 6. Metadata (best-effort — falls back to ID + thumbnail, never fake).
            const metadata = await fetchVideoMetadata(parsed.videoId, parsed.url, promo.youtubeApiKey);

            // 7. Build + publish (the bot posts; success is claimed only after send resolves).
            // The custom RISE SMP banner is branding artwork — the YouTube
            // URL stays the clickable destination.
            const payload = buildPromoPayload({
                kind,
                metadata,
                videoUrl: parsed.url,
                bannerUrl: promo.bannerUrl,
                member: interaction.member
            });
            let message = null;
            try {
                message = await channel.send(payload);
            } catch (error) {
                logger.error(`${where}: publishing failed — ${error?.stack || error}`);
                await interaction.editReply({ content: '❌ I couldn\'t publish your promotion (Discord API error). Please try again in a moment.' });
                return;
            }

            await videoPromotionRepository.recordPromotion(
                interaction.guildId, interaction.user.id, parsed.videoId, kind
            ).catch((error) => {
                logger.warn(`${where}: duplicate record could not be saved — ${error?.message || error}`);
            });

            logger.info(`${where}: published ${kind} promotion for video ...${parsed.videoId.slice(-4)} as message ${message?.id} in #${channel.name || channel.id}.`);

            if (kind === 'live') {
                await interaction.editReply({
                    content: `🔴 Your livestream promotion has been published!\n\nChannel: ${channel}`
                });
            } else {
                await interaction.editReply({
                    content: `✅ Your YouTube video promotion has been published!\n\nType: Video\nChannel: ${channel}`
                });
            }
        } catch (error) {
            logger.error(`${where} failed: ${error?.stack || error}`);
            await replyError(interaction, '❌ Something went wrong while publishing your promotion. Please try again.');
        }
    }
};
