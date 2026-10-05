# Setup Guide — Shaz Discord Bot

Get the bot from zero to online. Estimated time: 15–30 minutes.

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| Node.js | v18+ (`node -v` to check) |
| npm | ships with Node |
| MongoDB | v6+ — local install **or** free MongoDB Atlas cluster |
| Discord account | with permission to create applications |

## 2. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, give it a name (e.g. `Shaz`).
2. Left sidebar → **Bot** → **Reset Token** → copy the token. This is your `DISCORD_TOKEN`. **Never share or commit it.**
3. On the same **Bot** page, enable these **Privileged Gateway Intents** (required — the bot exits on boot without them):
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**
4. Still on the portal, go to **General Information** → copy the **Application ID**. This is your `CLIENT_ID`.

## 3. Invite the bot to your server

Build an invite URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

- `permissions=8` = Administrator (simplest; the bot manages channels/roles for tickets, moderation, autorole).
- For least privilege instead, grant at minimum: View Channels, Send Messages, Manage Channels, Manage Messages, Manage Roles, Kick/Ban Members, Moderate Members, Embed Links, Attach Files, Read Message History, Mention Everyone (for announces, if used).
- `applications.commands` scope is what makes slash commands appear.

> Setting up tickets or autorole later? The bot also needs its role **above** the roles it assigns/manages in Server Settings → Roles.

## 4. Set up MongoDB

**Option A — MongoDB Atlas (recommended, free):**
1. Create an account at [mongodb.com/atlas](https://www.mongodb.com/atlas) → free M0 cluster.
2. Database Access → create a user + password.
3. Network Access → allow your IP (or `0.0.0.0/0` for hosting).
4. Connect → **Drivers / Node.js** → copy the connection string, e.g.
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/shaz`

**Option B — Local MongoDB:**
Install MongoDB v6+ and use `mongodb://localhost:27017/shaz`.

> The bot still boots without a database, but anything that stores data (tickets, warnings, per-server settings, reminders, AFK) will report errors. Run with MongoDB.

## 5. Install & configure the project

```bash
cd /path/to/shaz
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN= paste_bot_token_here
CLIENT_ID=     paste_application_id_here
GUILD_ID=      paste_your_test_server_id_here   # dev: instant commands. Prod: leave empty (see below)
MONGODB_URI=   your_mongodb_connection_string
```

- **How to get your server (guild) ID:** Discord Settings → Advanced → enable **Developer Mode** → right-click your server → Copy Server ID.
- **`GUILD_ID` set** → commands register to that server **instantly** (use while developing).
- **`GUILD_ID` empty** → commands register **globally** (take up to **1 hour** to appear everywhere — normal Discord behavior, not a bug).

## 6. Configure the bot (`src/config/`)

Two YAML files:

**`src/config/modules.yml`** — on/off switch per module. Disabled modules load nothing at all:
```yaml
modules:
  welcome: true
  moderation: true
  tickets: true
  automod: true
  # … set any to false to disable
```

**`src/config/config.yml`** — global defaults: channel IDs, staff role IDs, limits, messages. Key sections to review on first install:
- `welcome:` — `channelId` (empty = system channel fallback), `gif` source (`local` → put your GIF at `assets/welcome.gif`, or `url`), greeting/description/footer text.
- `tickets:` — `panel.channelId`, `logs.channelId`, `categories:` (each with `categoryId` = Discord category for new ticket channels, `staffRoleIds:`), `maxOpenTicketsPerUser`, close behavior.
- `moderation.logs:` — log channel for mod actions.
- `automod:` / `antilink:` / `autorole:` — rules, exemptions, roles.

> You can also configure per-server later with `/setup`, `/ticket setup`, etc. — those values are stored in MongoDB and **override** the YAML defaults for that server only.

## 7. First run

```bash
npm start
```

Watch the startup report. Healthy boot looks like:

```
✅ Module loaded: tickets
✅ Command loaded: /ticket [tickets]
…
📊 Total Commands Loaded: 42
✅ Successfully registered 42 commands.
╔══════════════════════════════════════╗
║         🚀 STARTUP COMPLETE          ║
║ 📦 Modules:                     13   ║
║ 📋 Commands:                    42   ║
║ ⚡ Events:                       4    ║
║ ❌ Failed Commands:              0    ║
╚══════════════════════════════════════╝
```

Then in Discord: type `/help` — you should see every command grouped by module.

**Minimal first-server checklist:**
1. `/setup modlog-channel` + `/setup welcome-channel` (or set IDs in `config.yml`).
2. Tickets: `/ticket setup panel-channel:#support log-channel:#ticket-logs`, create categories in `config.yml` with `staffRoleIds`, then `/ticket panel`.
3. AutoMod/Anti-Link: `/automod status`, `/antilink status` — on by default.
4. Welcome: drop your GIF in `assets/welcome.gif`, use `/welcome` as the GUI control panel to configure settings, and preview with `/testwelcome`.

## 8. Running in production

- Process manager: `pm2 start index.js --name shaz` (or systemd / Docker). `npm run dev` (nodemon) is for development only.
- Keep `.env` out of git: it must never be committed.
- Logs: the bot writes daily files to `logs/` — check them first when something misbehaves.
- Back up MongoDB (Atlas does this automatically on paid tiers; `mongodump` for self-hosted).

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `DISCORD_TOKEN is missing` | `.env` not created or not in project root |
| `Used disallowed intents` + exit | Members / Message Content intents off in the Developer Portal (§2.3) |
| `CLIENT_ID is not set; cannot register slash commands` | `CLIENT_ID` empty in `.env` |
| Commands don't appear | Global registration takes up to 1h — set `GUILD_ID` for instant dev registration, then restart |
| `The database is not connected…` on commands | `MONGODB_URI` wrong/unreachable; check user password, IP allow-list (Atlas), `mongosh` connectivity |
| `I need the Manage Channels permission…` (tickets) | Bot role lacks permissions or sits below managed roles — fix role order |
| Buttons say "didn't respond" | Shouldn't happen (every interaction is acknowledged immediately); check `logs/` for errors and restart |
| Welcome GIF missing | `welcome.gif.path` wrong, or `source: "url"` with bad URL — bot warns in logs and sends text-only welcome |
| Port/IP issues on hosts | Only outbound HTTPS (Discord API) + MongoDB port needed; no inbound ports |

Need to understand *why* something behaves the way it does? Read [`instruction.md`](instruction.md).
