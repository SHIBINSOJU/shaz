# How Shaz Works — Instructions & Internals

This is the detailed manual: how the bot boots, how interactions flow, how each system behaves, and how to extend it. For installation, see [`setup.md`](setup.md). For the short version, see [`README.md`](README.md).

---

## 1. Boot sequence (`index.js`)

```
1. dotenv loads .env
2. discord.js Client created (intents: Guilds, GuildMembers, GuildMessages, MessageContent)
3. connectDatabase(MONGODB_URI)          → src/database/connection.js
4. moduleManager.loadModules(coreModule) → src/core/moduleManager.js
5. client.login(DISCORD_TOKEN) (3 attempts, 5s apart)
6. clientReady event → deployCommands() → startup report
```

Key behaviors:

- **Missing `DISCORD_TOKEN`** → logs an error and exits(1).
- **Missing privileged intents in the portal** → Discord rejects login with `Used disallowed intents`; the bot explains how to enable them and exits(1).
- **No MongoDB** → the bot still boots; DB-dependent commands reply with a graceful error. `isDatabaseReady()` / `requireDatabase()` (in `src/database/connection.js`) are the gates.
- **Flaky network** → `src/utils/retry.js` (`withRetry`, `isTransientError`) distinguishes transient gateway blips (logged, ignored — discord.js reconnects itself) from real errors.

## 2. Module system (the heart of the bot)

### Manifest contract

Every folder in `src/modules/<name>/` with an `index.js` is a candidate module:

```js
module.exports = {
    name: 'tickets',                 // required, unique
    async initialize(ctx) { … },     // optional, runs once at load
    commands: [ … ],                 // slash-command objects { data, execute }
    events: [ … ],                   // { name, once?, execute }
    components: [ … ]                // buttons/selects { customId, execute } (+ handleModal)
};
```

### Loading (`src/core/moduleManager.js` + `src/config/modules.yml`)

1. `coreModule` (help command + `clientReady` + `interactionCreate` events) registers first through the same pipeline.
2. Each folder in `src/modules/` is checked against `modules.yml` (`config.getModuleConfig(folder)`). Disabled → skipped with a log line, contributing **zero** commands/events/components.
3. `registerModule()` stores commands by name, wires events onto the client, indexes components by `customId`.
4. `startupLogger` prints the whole report (module/command/event counts, failures) — every number is derived from what actually registered, nothing hardcoded.

### Routing

- **Slash commands** → `src/core/events/interactionCreate.js` looks up `moduleManager.commands` by name and calls `command.execute(interaction, ctx)`. Unknown command → ephemeral warning. All handler errors funnel to one catch that replies/follows-up safely (never throws out of the event).
- **Buttons & select menus** → `src/core/componentHandler.js` `resolveComponent()`: exact `customId` match first, then longest `namespace:action` prefix match. So a component registered as `ticket` handles `ticket:claim:<ticketDbId>`, `ticket:close:<id>`, … — dynamic IDs carry the database ID, which handlers **re-validate against MongoDB** (custom IDs are never trusted).
- **Modals** → same resolution, dispatched to `component.handleModal(interaction)`.

### Interaction acknowledgement rules (must-read for contributors)

Discord requires every interaction to be acknowledged within ~3s, and exactly once (double-ack = `DiscordAPIError[40060]`):

- The **handler owns the ack** — `interactionCreate.js` never replies itself (except the unknown-command / top-level-error fallbacks).
- **Slow handlers `deferReply({ ephemeral: true })` FIRST**, then do DB/permission/Discord work, then finish with exactly one `editReply`. (Deferred interactions stay answerable for ~15 min.)
- **Never `reply()` after `deferReply()`**, never `deferReply()` twice, never `interaction.update()` after a defer.
- Fast handlers that only edit their own message (e.g. cancel buttons) use a single `interaction.update()`.
- Select → modal flows must call `showModal()` directly (it *is* the ack; it cannot be deferred).
- The ticket system (`ticketRouter.js`, `ticketModals.js`) is the reference implementation of all of the above.

## 3. Configuration layering

```
src/config/config.yml   → global defaults (checked into git)
        + MongoDB GuildSettings → per-server overrides (win when present)
        = effective config built by each module's config.js (resolveXConfig)
```

- `src/core/configService.js` loads the YAML once; modules read it via `configService.get('<section>')`.
- Per-server overrides are written by `/setup`, `/ticket setup`, etc. into the `GuildSettings` collection and resolved at call time — **restarting is never needed** after a `/setup` change.
- Discord snowflakes (IDs) are **always kept as strings** end-to-end (YAML numbers above 2⁵³ lose precision — quote IDs in YAML).

## 4. Database (`src/database/`)

Mongoose models + a repository layer. Only files in `repositories/` query Mongo — services never import models directly.

| Collection (model) | Purpose |
|---|---|
| `GuildSettings` | Per-server overrides: welcome, modlog, antilink, automod rules/words/exemptions, embed roles, autorole, management roles, suggestions/polls channels, tickets |
| `Ticket` / `TicketCounter` | Ticket records (`number` = human ticket ID via atomic per-guild counter; `userId` = creator; `status`: open/claimed/closed/deleted; full audit: claimed/closed/reopened/deleted by+at) |
| `Warning` | Persistent moderation warnings |
| `Afk` | AFK states |
| `Reminder` / `Poll` / `Suggestion` | Personal reminders, polls, suggestions |

## 5. UI: Components V2

No legacy embeds anywhere. Rich messages use Containers, TextDisplays, Separators, Sections, Media Galleries (`MessageFlags.IsComponentsV2`). Shared builders live in `src/utils/componentsV2.js` (`buildInfoContainer`, …). Other utils: `placeholders.js` (`{user}`, `{server}`, `{membercount}`, styled-name pseudo-fonts…), `textStyle.js`, `retry.js`.

---

## 6. Module-by-module guide

### 🎫 Tickets (`/ticket …`)
Flow: `/ticket panel` posts a category select → user picks → reason modal → private channel **`ticket-<username>`** is created (creator + staff roles + bot only) with one ticket message (`🎯 Claim` / `🔒 Close`).
- **Claim** — allowed for **server owner, Administrators, configured staff roles only**. The creator can NEVER claim their own ticket (checked in both the button handler and the service, so forged custom IDs can't bypass it). Saves `claimedBy`/`claimedAt`, edits the ticket message (`Claimed by: @…`), logs. Already claimed → `⚠️ already claimed by @…` (no overwrite unless `allowReclaim: true` in config).
- **Close** — creator (if `creatorCanClose`, default true) or staff. Asks for confirmation (`Confirm Close` / `Cancel`), then archives: status → `closed`, creator locked to read-only, channel moved to the closed category, renamed **`closed-<username>`** (always rebuilt from the stored creator ID — never stacked prefixes, never `ticket-user`). The one ticket message is edited to `🔓 Reopen` / `🗑️ Delete` buttons.
- **Reopen** — closed tickets only; restores category, creator permissions, and `ticket-<username>`; edits the same message back.
- **Delete** — closed tickets, staff only. Confirmation first; the deletion is **logged before** the channel is removed and the DB is marked `deleted` before the response is sent (so nothing tries to answer inside a deleted channel).
- **Safety nets**: per-ticket operation locks + fresh-DB revalidation make double-clicks collapse to one effect; channel renames/moves are time-bounded so Discord rate limits can't stall a flow; ghost records (channel manually deleted) auto-close so users aren't blocked.
- Subcommands: `setup` (panel/log channels, max tickets, closed category, delete-on-close), `panel`, `close`, `claim`, `add <user>`, `remove <user>`, `config` (effective config with resolved channels/roles), `status` (server + your open tickets).

### 🛡️ Moderation
`/warn` (stored in MongoDB with numeric warning IDs), `/unwarn`, `/warnings`, `/kick`, `/ban` (optional 0–7 day message purge), `/unban`, `/timeout` (1–40320 min), `/clear` (1–100, optional user filter), `/lock`/`/unlock`, `/slowmode`. Every command validates: executor permission, bot permission, role hierarchy (can't act above/equal), no self-target, no owner-target. All actions post to the mod-log channel (`/setup modlog-channel`, toggleable).

### 👋 Welcome
On `guildMemberAdd` (skips bots unless `welcomeBots: true`): posts an intro text block — `🎮 Welcome to our Blocky Universe!` / `Hey @{mention} 👋` / the configured welcome message — **above** the existing GIF card, then the GIF card: local `assets/welcome.gif` with the member's name baked into a throwaway copy (`usernameInCard: true`), or a hosted URL, or text-only fallback with a startup/log warning (never a crash). Greeting/footer support `{placeholders}` (see README), and `allowedMentions` limits pings to the joining member only.

`/welcome` provides a GUI control panel over the same `GuildSettings.welcome` section and the same WelcomeBuilder/card renderer. Field mapping: `message` → `description`, `cardEnabled` → `usernameInCard`, `thumbnailEnabled` → `gif.enabled`, `separatorEnabled` → `separatorEnabled`. Per-server channel/enabled/bots also support `/setup welcome-*` (Mongo overrides). `/testwelcome` renders the identical builder for previews.

### 🤖 AutoMod (`/automod …`)
10 toggleable rules: `antiLink, antiInvite, antiSpam, antiDuplicate, antiMentionSpam, antiCaps, wordFilter, antiEveryone, antiRaid, massSpam`. `status` shows all rules 🟢/🔴; `enable|disable` flips the master switch; `config` shows thresholds; `rule enable|disable <rule>` per rule; `word …` manages the custom word list (file-level words + per-server additions). Punishments: delete + ephemeral warning, optional timeouts (`timeout.enabled`, mass-spam/raid), role/channel/user exemptions, `punishAdmins: false` default. Raid detection alerts without mass-banning.

### 🔗 Anti-Link (`/antilink …`)
Standalone link blocker (also reusable by AutoMod's `antiLink` rule): `enable|disable`, per-channel `channel enable|disable #ch`, `status`. Deletes link messages, warns (auto-deleting, cooldown-throttled), logs via modlog. Exempts admins (configurable), mods (opt-in), bots, webhooks.

### 🎭 AutoRole (`/autorole …`)
`enable|disable`, `add @role`, `remove @role`, `list`, `clear`, `status`. Assigns configured roles to newcomers (optional delay, optional bots), logs to modlog. Needs Manage Roles + role hierarchy above assigned roles.

### 🧱 Embed Builder (`/embed`, `/embedconfig`)
Interactive 15-minute session that builds a Components V2 message (title, description, fields, color, image, footer, buttons…) with live preview, then posts it to a chosen channel. Access: owner + Administrators + extra roles via `/embedconfig role-add|role-remove|role-list`.

### 📢 Management (`/announce /poll /say /suggest`)
- `/announce` — title/description/image/color/footer + optional role mention / @everyone → posts a styled announcement (extra allowed roles configurable in `management.allowedRoleIds`).
- `/poll` — up to 5 options, optional duration, button voting, results stored in MongoDB.
- `/say` — send a message as the bot (admin/allowed roles).
- `/suggest` — posts suggestions to the configured channel for voting.

### 👤 Personal (`/afk /remind /reminders`)
- `/afk [reason]` — sets AFK state (stored); the bot announces it when you're mentioned and welcomes you back on return.
- `/remind <duration: 30s|15m|2h|7d> <message>` + `/reminders` (list/cancel) — persisted in MongoDB so they survive restarts.

### 🎉 Fun (`/8ball /choose /coinflip /dice`) — no setup, just works.

### 🛠️ Utility — read-only info commands
`/ping` (latency), `/uptime`, `/botinfo`, `/serverinfo`, `/userinfo`, `/avatar`, `/banner`, `/servericon`, `/membercount`, `/roleinfo`, `/channelinfo`.

### 🎮 Minecraft (`/serverip`)
- `/serverip [edition: all|java|bedrock]` — **ephemeral** Components V2 container with the connection addresses (Java `risesmp.online` — a bare host with **no port**; Bedrock always as separate fields — IP: `risesmp.online` / Port: `25890`, using the port configured under `minecraft.ipResponse.bedrock.port`).
- **Keyword trigger (DM, never public)**: `messageCreate` detects phrases like `ip`, `server ip`, `how to join`, `java ip`, `bedrock ip`, or `risesmp.online` and DMs the requester the full Components V2 IP panel with the `[☕ Java IP] [🪨 Bedrock IP] [🎮 Both]` buttons (per-channel/user cooldown, bots/webhooks excluded, zero pings, redelivery dedupe). Because a `messageCreate` event cannot send an ephemeral message, nothing is posted to the channel at all — the DM is the private equivalent. If DMs are closed, a single short hint without any address is posted instead. Every `mc:ip:*` button (and `/serverip`) answers **ephemeral** (or updates the DM in place), so the IP never appears in the channel.

### ⚙️ Setup & Help
- `/setup welcome-channel|welcome-toggle|welcome-bots|modlog-channel|modlog-toggle|view` — per-server MongoDB overrides (Manage Server only).
- `/help` — auto-generated command list grouped by module; `/help command:<name>` — details. New modules appear automatically.

## 7. Permissions & logging conventions

- Slash-command defaults (`setDefaultMemberPermissions`) keep admin commands out of sight, but **every handler re-checks permissions at runtime** (the displayed default is cosmetic).
- Server owner + Administrators are the universal fallback for staff-gated actions; ticket claim is deliberately narrower (owner/admin/staff-roles, never the creator).
- Operational logs → `logs/YYYY-MM-DD.log` (daily files). User-facing action logs → the configured Discord channels (modlog, ticket log).

## 8. Adding a new module (checklist)

1. `src/modules/mymod/index.js` exporting `{ name, initialize?, commands[], events[], components[] }`.
2. Commands: `{ data: new SlashCommandBuilder()…, async execute(interaction, ctx) }` — defer first if slow, exactly one response.
3. Events: `{ name, once?, execute(...args, client) }`.
4. Buttons/selects: `{ customId: 'mymod', execute }` (+ `handleModal` for modals); use IDs like `mymod:action:<dbId>` and re-validate against the DB.
5. Defaults in `src/config/config.yml`, switch in `src/config/modules.yml`, per-server overrides in `GuildSettings` + a `config.js` resolver if needed.
6. Data goes in `src/database/models/` + `repositories/` — services never touch Mongoose directly.
7. UI in Components V2 via `src/utils/componentsV2.js`. Never mix V2 and legacy embed fields in one payload.

## 9. Conventions & gotchas

- **IDs are strings** everywhere (quote snowflakes in YAML).
- **Channel names**: lowercase alphanumerics + `-`/`_`, max 100 chars — use `sanitizeSegment`-style normalization, never raw usernames.
- **Channel updates are rate-limited** (~2 renames/10 min/channel): bound such calls with timeouts; keep the DB authoritative; let names self-heal on the next transition.
- **Respond-then-destroy**: never delete a channel before answering the interaction that lives in it.
- **Ghost records**: if your feature stores a channel/message ID, handle "manually deleted" gracefully (fetch → null → repair the record, don't strand the user).
- **Logs dir**: read `logs/` first when debugging; the startup report tells you exactly what loaded.
