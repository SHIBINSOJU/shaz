# Shaz — Modular Discord Bot

A production-quality, highly modular Discord bot built with **Node.js**, **discord.js v14**, and **MongoDB**. Everything is a module: each feature (tickets, moderation, welcome, …) lives in its own folder under `src/modules/`, registers its own slash commands / events / buttons, and can be enabled or disabled without touching anything else.

> **New here?** Start with [`setup.md`](setup.md) to get the bot online, then read [`instruction.md`](instruction.md) to learn how it all works.

## Requirements

- **Node.js** v18 or higher
- **MongoDB** v6 or higher (local or MongoDB Atlas)
- A Discord application + bot token (see [`setup.md`](setup.md))
- Privileged intents enabled: **Server Members Intent**, **Message Content Intent**

## Quick start

```bash
npm install
cp .env.example .env   # then fill in DISCORD_TOKEN, CLIENT_ID, MONGODB_URI
npm start              # or: npm run dev (auto-restart via nodemon)
```

Full step-by-step guide (Discord portal, invite link, MongoDB, config, production hosting, troubleshooting): [`setup.md`](setup.md).

## Features (all 12 modules)

| Module | What it does | Key commands |
|---|---|---|
| 🎫 Tickets | Support ticket panel, claims, close/reopen/delete flows | `/ticket setup|panel|close|claim|add|remove|config|status` |
| 🛡️ Moderation | Warns (persistent), kick/ban/timeout, channel lock, slowmode, cleanup | `/warn /unwarn /warnings /kick /ban /unban /timeout /clear /lock /unlock /slowmode` |
| 👋 Welcome | Animated GIF welcome card (Components V2), per-server settings | `/welcome`, `/testwelcome`, `/setup welcome-*` |
| 🤖 AutoMod | 10-rule automatic moderation engine | `/automod status|enable|disable|config|rule|word` |
| 🔗 Anti-Link | Link blocking with exemptions & cooldowns | `/antilink enable|disable|channel|status` |
| 🎭 AutoRole | Automatically assign roles to new members | `/autorole enable|disable|add|remove|list|clear|status` |
| 🧱 Embed Builder | Interactive Components V2 embed/message builder | `/embed`, `/embedconfig` |
| 📢 Management | Announcements, polls, suggestions, say | `/announce /poll /suggest /say` |
| 👤 Personal | AFK status, personal reminders | `/afk /remind /reminders` |
| 🎉 Fun | 8ball, choice picker, coin flip, dice | `/8ball /choose /coinflip /dice` |
| 🛠️ Utility | Server/user info, avatar, banner, ping, uptime | `/avatar /banner /botinfo /userinfo /serverinfo /…` |
| 🎮 Minecraft | Server IP: public IP-free trigger prompt, address delivered only ephemerally via `/serverip` & buttons | `/serverip` |
| ⚙️ Setup | Per-server configuration stored in MongoDB | `/setup …`, `/help` |

Highlights:

- **Tickets** — category panel → reason modal → private channel `ticket-<username>`; staff claim (owner/admins/staff-roles only — the creator can never claim their own ticket); close confirmation → `closed-<username>` archive; reopen restores everything; delete is logged *before* the channel is removed. Every button acknowledges instantly, so interactions never time out.
- **Moderation** — warnings persist in MongoDB across restarts; every command checks executor/bot permissions, role hierarchy, and self/owner targeting; all actions go to a configurable log channel.
- **Welcome** — opens with the intro text (`🎮 Welcome to our Blocky Universe!` + a direct mention of the new member + the configured message) **above** the card; the configured GIF *is* the card (local file with the member's name baked in, or a hosted URL), rendered in a Components V2 media gallery with greeting/footer and `{placeholder}` templating. Only the joining member can be pinged.
- **Components V2 everywhere** — no legacy embeds; reusable builders live in `src/utils/componentsV2.js`.

## Architecture (short version)

```
index.js → connects MongoDB → ModuleManager loads core + enabled modules
         → discord.js login → clientReady deploys slash commands → bot ready
```

- **Core** (`src/core/`): client boot, slash-command deployment, interaction routing (`interactionCreate`), button/select routing by `customId` prefix (`componentHandler`), YAML config service, startup diagnostics, logger.
- **Modules** (`src/modules/<name>/`): `index.js` manifest + `commands/` + `events/` + `components/` (+ `modals/`, `services/` as needed).
- **Config layering**: `src/config/*.yml` holds global defaults; per-server overrides live in MongoDB (`GuildSettings`) and win when present.
- **Database** (`src/database/`): Mongoose models + repository layer — nothing outside `repositories/` talks to Mongo directly.

Deep dive (boot sequence, routing, custom-ID scheme, config resolution, database schema, permission model, how to add a module): [`instruction.md`](instruction.md).

## Project structure

```
├── index.js                 # entry point: DB → modules → login
├── .env / .env.example      # secrets (never commit .env)
├── assets/                  # welcome.gif and other static files
├── logs/                    # daily log files
└── src/
    ├── core/                # ModuleManager, events, commands/help, configService, logger…
    ├── config/              # config.yml (defaults), modules.yml (on/off switches)
    ├── database/            # connection, models/, repositories/
    ├── modules/             # 12 feature modules (see table above)
    └── utils/               # componentsV2, placeholders, retry, textStyle
```

## Configuration

- `src/config/modules.yml` — turn modules on/off. Disabled modules register **zero** commands, events, or buttons.
- `src/config/config.yml` — global defaults for every module (channels, roles, limits, messages…).
- `/setup` + per-module setup commands (`/ticket setup`, …) — per-server overrides saved to MongoDB.

## Adding a new module

1. Create `src/modules/mymodule/` with an `index.js` manifest (`{ name, commands, events, components }`).
2. Put slash commands in `commands/`, listeners in `events/`, buttons/selects in `components/`.
3. Enable it in `src/config/modules.yml`.

The `ModuleManager` auto-discovers the folder — no core changes needed. See [`instruction.md`](instruction.md) for the full manifest contract and conventions.

## License

ISC
