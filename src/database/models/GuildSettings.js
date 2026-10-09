const mongoose = require('mongoose');

const guildSettingsSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    // ONE welcome section, shared by /setup, /welcome and the guildMemberAdd
    // event. `null` = inherit the config.yml default (see welcome/services/settings.js).
    // The panel fields map onto existing renderer keys: message -> description,
    // cardEnabled -> usernameInCard, thumbnailEnabled -> gif.enabled.
    welcome: {
        channelId: { type: String, default: null },
        enabled: { type: Boolean, default: null },
        welcomeBots: { type: Boolean, default: null },
        message: { type: String, default: null },
        thumbnailEnabled: { type: Boolean, default: null },
        separatorEnabled: { type: Boolean, default: null },
        cardEnabled: { type: Boolean, default: null }
    },
    moderation: {
        logChannelId: { type: String, default: null },
        logsEnabled: { type: Boolean, default: null }
    },
    // Per-category server logging (src/modules/logs). `null` = inherit default.
    // The `moderation` category falls back to moderation.logChannelId when unset,
    // so the legacy /setup modlog-channel keeps working.
    logs: {
        member: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        message: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        voice: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        channel: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        role: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        moderation: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        server: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        },
        invite: {
            enabled: { type: Boolean, default: null },
            channelId: { type: String, default: null }
        }
    },
    antilink: {
        enabled: { type: Boolean, default: null },
        disabledChannels: { type: [String], default: [] },
        exemptRoles: { type: [String], default: [] }
    },
    automod: {
        enabled: { type: Boolean, default: null },
        rules: {
            antiLink: { enabled: { type: Boolean, default: null } },
            antiInvite: { enabled: { type: Boolean, default: null } },
            antiSpam: { enabled: { type: Boolean, default: null } },
            antiDuplicate: { enabled: { type: Boolean, default: null } },
            antiMentionSpam: { enabled: { type: Boolean, default: null } },
            antiCaps: { enabled: { type: Boolean, default: null } },
            wordFilter: { enabled: { type: Boolean, default: null } },
            antiEveryone: { enabled: { type: Boolean, default: null } },
            antiRaid: { enabled: { type: Boolean, default: null } },
            massSpam: { enabled: { type: Boolean, default: null } }
        },
        words: { type: [String], default: [] },
        exemptRoles: { type: [String], default: [] },
        exemptChannels: { type: [String], default: [] },
        exemptUsers: { type: [String], default: [] },
        // Channels where the Anti-Invite rule is not enforced (invites allowed).
        antiInviteDisabledChannels: { type: [String], default: [] },
        // Staff roles: exempt from EVERYTHING (automod engine + legacy
        // anti-link listener). Source of truth for /automod staff list; the
        // staff command mirrors these ids into exemptRoles + antilink
        // exemptRoles so both enforcement pipelines pick them up.
        staffRoleIds: { type: [String], default: [] }
    },
    embed: {
        allowedRoleIds: { type: [String], default: [] }
    },
    autorole: {
        enabled: { type: Boolean, default: null },
        roles: { type: [String], default: [] },
        bots: { type: Boolean, default: null },
        delay: { type: Number, default: null }
    },
    management: {
        allowedRoleIds: { type: [String], default: [] }
    },
    suggestions: {
        channelId: { type: String, default: null }
    },
    polls: {
        channelId: { type: String, default: null }
    },
    tickets: {
        panelChannelId: { type: String, default: null },
        logChannelId: { type: String, default: null },
        logsEnabled: { type: Boolean, default: null },
        maxOpenTicketsPerUser: { type: Number, default: null },
        closedCategoryId: { type: String, default: null },
        deleteImmediately: { type: Boolean, default: null }
    }
}, { timestamps: true });

module.exports = mongoose.model('GuildSettings', guildSettingsSchema);
