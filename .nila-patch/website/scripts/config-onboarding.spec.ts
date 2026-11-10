// Offline tests for the onboarding configuration layer (Welcome system P2).
//
// No network, no Discord login, no live API calls, no credentials, no
// database, no messages sent: validation runs as pure functions and the
// save/read flows run against strict in-memory stores that behave like real
// revision-guarded storage (stale writes change nothing, reads never
// provision, unexpected collection access throws).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ReactNamespace from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CARD_ATTACHMENT_URL,
  decodeOnboardingUpload,
  handleOnboarding,
  handleOnboardingUpload,
  importOnboardingUpload,
  ONBOARDING_CHUNK_BYTES,
  ONBOARDING_UPLOAD_MAX_GIF_BYTES,
  onboardingUploadBudget,
  parseUploadSourceUrl,
  readOnboarding,
  resetOnboardingChunkSessions,
  validateCard,
  validateOnboarding,
  validateOnboardingBody,
  validateWelcomeDesign,
} from "../src/lib/config/onboardingConfig";
import { previewOnboardingDesign, previewOnboardingText } from "../src/lib/onboarding-preview";
import type { OnboardingDocument, OnboardingStore, OnboardingValues } from "../src/lib/config/onboardingConfig";

const SOURCE_ROOT = resolve(__dirname, "..");
const GUILD_ID = "123456789012345678";
const USER_ID = "323456789012345678";
const CHANNEL_ID = "423456789012345678";
const ROLE_ID = "523456789012345678";
const ROLE = "723456789012345678";
const SITE_URL = "http://localhost:3000";

function readSource(relativePath: string): string {
  return readFileSync(resolve(SOURCE_ROOT, relativePath), "utf8");
}

function maintainGuild() {
  return [{ id: GUILD_ID, name: "Onboarding Tests", icon: null, owner: false, permissions: "32" }];
}

function validSession() {
  return {
    user: { id: USER_ID, username: "tester", global_name: "Tester", avatar: null },
    accessToken: "test-access-token-never-sent",
    expiresAt: Date.now() + 3_600_000,
  };
}

function simpleDesign(kind: "text" | "linkButton" | "card" = "text") {
  if (kind === "linkButton") {
    return {
      name: "buttons",
      components: [{
        key: "row1", kind: "actionRow",
        components: [{ key: "b1", kind: "button", style: 5, label: "Rules", url: "https://example.com/rules" }],
      }],
    };
  }
  if (kind === "card") {
    return {
      name: "card-message",
      components: [
        { key: "t1", kind: "textDisplay", content: "## Welcome {user}!" },
        { key: "g1", kind: "mediaGallery", items: [{ url: CARD_ATTACHMENT_URL, description: "Welcome card" }] },
      ],
    };
  }
  return { name: "plain", components: [{ key: "t1", kind: "textDisplay", content: "Hello {user}, welcome to {guild}!" }] };
}

function fullConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const welcome = {
    enabled: false,
    channelId: null,
    mode: "channel",
    mention: false,
    design: null,
    card: null,
    cardEnabled: false,
    ...((overrides.welcome as Record<string, unknown>) ?? {}),
  };
  const goodbye = {
    enabled: false,
    channelId: null,
    design: null,
    ...((overrides.goodbye as Record<string, unknown>) ?? {}),
  };
  const autoRoles = {
    enabled: false,
    roleIds: [],
    skipBots: true,
    ...((overrides.autoRoles as Record<string, unknown>) ?? {}),
  };
  return {
    welcome,
    goodbye,
    autoRoles,
    joinLogChannelId: (overrides.joinLogChannelId ?? null) as unknown,
  };
}

function issuePaths(issues: { path: string; message: string }[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join(" | ");
}

// ---------------------------------------------------------------------------
// In-memory CAS store with strict access tracking.
// ---------------------------------------------------------------------------

function fakeStore(initial: OnboardingDocument | null = null) {
  const calls: string[] = [];
  let document: OnboardingDocument | null = initial;
  const store: OnboardingStore = {
    async get() {
      calls.push("get");
      return document === null ? null : ({ ...document });
    },
    async saveCas({ guildId, values, expectedRevision }) {
      calls.push("save");
      if (expectedRevision === 0) {
        if (document !== null) return { ok: false as const, reason: "stale" as const };
        document = { guildId, revision: 1, updatedAt: new Date().toISOString(), ...values };
        return { ok: true as const, document: { ...document } };
      }
      if (document === null || document.revision !== expectedRevision) {
        return { ok: false as const, reason: "stale" as const };
      }
      document = { guildId, revision: expectedRevision + 1, updatedAt: new Date().toISOString(), ...values };
      return { ok: true as const, document: { ...document } };
    },
  };
  return { store, calls, current: () => document };
}

function handlePatch(store: OnboardingStore, body: unknown, args: Partial<Parameters<typeof handleOnboarding>[0]> = {}) {
  return handleOnboarding({
    method: "PATCH",
    contentType: "application/json",
    guildId: GUILD_ID,
    origin: SITE_URL,
    siteUrl: SITE_URL,
    bodyText: JSON.stringify(body),
    session: validSession(),
    guilds: maintainGuild(),
    isRateLimited: () => false,
    store,
    ...args,
  });
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

test("a disabled default configuration validates cleanly", () => {
  const { values, issues } = validateOnboarding(fullConfig());
  assert.deepEqual(issues, []);
  assert.ok(values);
  assert.equal(values.welcome.enabled, false);
  assert.equal(values.welcome.design, null);
});

test("an enabled welcome requires a channel and a valid design", () => {
  const missing = validateOnboarding(fullConfig({ welcome: { enabled: true, cardEnabled: true } }));
  assert.match(issuePaths(missing.issues), /needs a channel/);
  assert.match(issuePaths(missing.issues), /needs a valid message design/);

  const good = validateOnboarding(fullConfig({
    welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel", mention: false, design: simpleDesign("text"), cardEnabled: true, card: null },
  }));
  assert.deepEqual(good.issues, []);
  assert.ok(good.values?.welcome.design);
});

test("welcome designs enforce the simple-block rules", () => {
  // One container may wrap the whole message (the Discord-native card look).
  const container = { name: "c", components: [{ key: "k", kind: "container", components: [{ key: "t", kind: "textDisplay", content: "hi" }] }] };
  assert.deepEqual(validateWelcomeDesign(container, "welcome.design").issues, []);

  const containerWithSibling = {
    name: "cs",
    components: [
      { key: "k", kind: "container", components: [{ key: "t", kind: "textDisplay", content: "hi" }] },
      { key: "t2", kind: "textDisplay", content: "outside" },
    ],
  };
  assert.match(issuePaths(validateWelcomeDesign(containerWithSibling, "d").issues), /only top-level block/);

  const nestedContainer = {
    name: "n",
    components: [{ key: "k", kind: "container", components: [{ key: "inner", kind: "container", components: [{ key: "t", kind: "textDisplay", content: "hi" }] }] }],
  };
  assert.match(issuePaths(validateWelcomeDesign(nestedContainer, "d").issues), /cannot be nested/);

  const containerHoldingSelect = {
    name: "nq",
    components: [{ key: "k", kind: "container", components: [{ key: "r", kind: "actionRow", components: [{ key: "s", kind: "stringSelect", customId: "s", options: [{ label: "a", value: "a" }] }] }] }],
  };
  assert.match(issuePaths(validateWelcomeDesign(containerHoldingSelect, "d").issues), /Select menus are not allowed/);

  const interactive = {
    name: "i",
    components: [{ key: "r", kind: "actionRow", components: [{ key: "b", kind: "button", style: 2, label: "Claim", customId: "claim" }] }],
  };
  assert.match(issuePaths(validateWelcomeDesign(interactive, "d").issues), /Link buttons/);

  const select = {
    name: "s",
    components: [{ key: "r", kind: "actionRow", components: [{ key: "s", kind: "stringSelect", customId: "s", options: [{ label: "a", value: "a" }] }] }],
  };
  assert.match(issuePaths(validateWelcomeDesign(select, "d").issues), /Select menus are not allowed/);

  // The member avatar is the second permitted attachment reference; anything
  // else stays rejected.
  const avatarGreeting = {
    name: "av",
    components: [{ key: "g", kind: "section", components: [{ key: "t", kind: "textDisplay", content: "Welcome {user}!" }], accessory: { key: "th", kind: "thumbnail", url: "attachment://member-avatar.png" } }],
  };
  assert.deepEqual(validateWelcomeDesign(avatarGreeting, "d").issues, []);

  const badAttachment = {
    name: "a",
    components: [{ key: "g", kind: "mediaGallery", items: [{ url: "attachment://something-else.png" }] }],
  };
  assert.match(issuePaths(validateWelcomeDesign(badAttachment, "d").issues), /member avatar reference/);

  const cardOk = validateWelcomeDesign(simpleDesign("card"), "d");
  assert.deepEqual(cardOk.issues, []);
  const https = { name: "h", components: [{ key: "g", kind: "mediaGallery", items: [{ url: "https://cdn.example.com/a.png" }] }] };
  assert.deepEqual(validateWelcomeDesign(https, "d").issues, []);
});

test("auto-roles, goodbye, and log channel shapes are enforced", () => {
  assert.match(issuePaths(validateOnboarding(fullConfig({ autoRoles: { enabled: true, roleIds: [], skipBots: true } })).issues), /at least one role/);
  assert.match(issuePaths(validateOnboarding(fullConfig({ autoRoles: { enabled: false, roleIds: ["not-a-snowflake"], skipBots: true } })).issues), /valid role id/);
  assert.match(issuePaths(validateOnboarding(fullConfig({ autoRoles: { enabled: false, roleIds: [ROLE_ID, ROLE_ID], skipBots: true } })).issues), /unique/);
  assert.match(issuePaths(validateOnboarding(fullConfig({ joinLogChannelId: "12" })).issues), /channel id or null/);
  assert.match(issuePaths(validateOnboarding(fullConfig({ goodbye: { enabled: true } })).issues), /goodbye.*needs a channel/);
});

test("card settings stay within bounds", () => {
  // Wording follows the shared nila-card validator the dashboard delegates to,
  // so these messages are the bot's messages rather than a second local copy.
  assert.match(issuePaths(validateCard({ preset: "nope" }, "card").issues), /Unknown card preset/);
  assert.match(issuePaths(validateCard({ avatar: { xPct: 130 } }, "card").issues), /Avatar x must be 0-100/);
  assert.match(issuePaths(validateCard({ size: { width: 100, height: 10 } }, "card").issues), /320-1920/);
  assert.match(issuePaths(validateCard({ lines: Array.from({ length: 5 }, () => ({ text: "x", color: "#FFFFFF", weight: "bold" })) }, "card").issues), /at most 4/);
  assert.match(issuePaths(validateCard({ lines: [{ text: "hi", color: "red", weight: "bold" }] }, "card").issues), /#RRGGBB/);
  // The rules the duplicated dashboard copy used to miss entirely.
  assert.match(issuePaths(validateCard({ transparent: "yes" }, "card").issues), /Transparency must be a boolean/);
  assert.match(issuePaths(validateCard({ backgroundFit: "tile" }, "card").issues), /Invalid background fit/);
  assert.match(issuePaths(validateCard({ lines: [{ text: "x", color: "#FFFFFF", weight: "bold", fontSize: 5000 }] }, "card").issues), /bounded/);
  assert.deepEqual(validateCard({ preset: "river-1", avatar: { xPct: 20, yPct: 50, sizePct: 45, shape: "circle", ringColor: "#22d3ee" }, lines: [{ text: "{user}", xPct: 40, yPct: 60, sizePct: 8, color: "#FFFFFF", weight: "bold" }], backgroundDim: 20 }, "card").issues, []);
});

test("body allowlist is exact and requires a valid revision", () => {
  assert.equal(validateOnboardingBody({ ...fullConfig(), expectedRevision: 0 }).ok, true);
  assert.equal(validateOnboardingBody({ ...fullConfig() }).ok, false, "missing expectedRevision");
  assert.equal(validateOnboardingBody({ ...fullConfig(), expectedRevision: 1.5 }).ok, false);
  assert.equal(validateOnboardingBody({ ...fullConfig(), expectedRevision: -1 }).ok, false);
  assert.equal(validateOnboardingBody({ ...fullConfig(), expectedRevision: 0, enabled: true }).ok, false, "foreign keys rejected");
});

// ---------------------------------------------------------------------------
// Save flow — CAS, authorization, and failure mapping.
// ---------------------------------------------------------------------------

test("first save creates revision 1 and later saves advance atomically", async () => {
  const { store, current } = fakeStore();
  const body = { ...fullConfig({ welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel", mention: false, design: simpleDesign("text"), card: null } }), expectedRevision: 0 };
  const first = await handlePatch(store, body);
  assert.equal(first.status, 200);
  assert.equal(current()?.revision, 1);

  const second = await handlePatch(store, { ...body, expectedRevision: 1 });
  assert.equal(second.status, 200);
  assert.equal(current()?.revision, 2);

  const stale = await handlePatch(store, { ...body, expectedRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(current()?.revision, 2, "a rejected write changes nothing");
});

test("a rejected write hands back the winning document so the editor can retry", async () => {
  const { store, current } = fakeStore();
  const body = { ...fullConfig(), expectedRevision: 0 };
  assert.equal((await handlePatch(store, body)).status, 200);
  assert.equal((await handlePatch(store, { ...body, expectedRevision: 1 })).status, 200);

  const loser = await handlePatch(store, { ...body, expectedRevision: 1 });
  assert.equal(loser.status, 409);
  const loserBody = loser.body as { error: string; onboarding?: { revision: number } };
  assert.equal(loserBody.error, "stale-revision");
  assert.equal(loserBody.onboarding?.revision, 2, "the 409 carries the version that won");
  assert.equal(current()?.revision, 2, "the rejected write still changed nothing");

  // The whole point: a retry against the returned revision now goes through.
  const retry = await handlePatch(store, { ...body, expectedRevision: loserBody.onboarding!.revision });
  assert.equal(retry.status, 200);
  assert.equal(current()?.revision, 3);
});

test("a 409 still stands when the current document cannot be read back", async () => {
  const unreadable: OnboardingStore = {
    async get() {
      throw new Error("collection unavailable");
    },
    async saveCas() {
      return { ok: false as const, reason: "stale" as const };
    },
  };
  const result = await handlePatch(unreadable, { ...fullConfig(), expectedRevision: 4 });
  assert.equal(result.status, 409);
  const body = result.body as { error: string; onboarding?: unknown };
  assert.equal(body.error, "stale-revision");
  assert.equal("onboarding" in body, false, "no document is invented when the read fails");
});

test("an invalid configuration never reaches the store", async () => {
  const { store, calls } = fakeStore();
  const result = await handlePatch(store, { ...fullConfig({ autoRoles: { enabled: true, roleIds: ["bad"], skipBots: true } }), expectedRevision: 0 });
  assert.equal(result.status, 400);
  assert.equal(calls.includes("save"), false);
});

test("save authorization and transport guards hold", async () => {
  const { store } = fakeStore();
  const body = { ...fullConfig(), expectedRevision: 0 };

  const anonymous = await handlePatch(store, body, { session: { user: undefined, accessToken: undefined, expiresAt: 0 } });
  assert.equal(anonymous.status, 401);

  const wrongGuild = await handlePatch(store, body, { guildId: "999999999999999999" });
  assert.equal(wrongGuild.status, 403);

  const badOrigin = await handlePatch(store, body, { origin: "https://evil.example" });
  assert.equal(badOrigin.status, 403);

  const limited = await handlePatch(store, body, { isRateLimited: () => true });
  assert.equal(limited.status, 429);

  const wrongMethod = await handleOnboarding({
    method: "POST", contentType: "application/json", guildId: GUILD_ID, origin: SITE_URL, siteUrl: SITE_URL,
    bodyText: JSON.stringify(body), session: validSession(), guilds: maintainGuild(), isRateLimited: () => false, store,
  });
  assert.equal(wrongMethod.status, 405);

  const badJson = await handlePatch(store, "not-json" as unknown, { bodyText: "{" });
  assert.equal(badJson.status, 400);
});

// ---------------------------------------------------------------------------
// Reads never provision and never trust malformed stored data.
// ---------------------------------------------------------------------------

test("read reports not-configured for a missing document without writing", async () => {
  const { store, calls } = fakeStore(null);
  const result = await readOnboarding({ session: validSession(), guilds: maintainGuild(), guildId: GUILD_ID, store });
  assert.ok(result.ok);
  assert.equal(result.data.status, "not-configured");
  assert.deepEqual(calls, ["get"], "the read path performs no write");
});

test("read of a stored valid document returns it; malformed documents report invalid", async () => {
  const values: OnboardingValues = validateOnboarding(fullConfig({
    welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel", mention: false, design: simpleDesign("text"), card: null },
  })).values!;
  const document: OnboardingDocument = { guildId: GUILD_ID, revision: 4, updatedAt: new Date().toISOString(), ...values };
  const ok = await readOnboarding({ session: validSession(), guilds: maintainGuild(), guildId: GUILD_ID, store: fakeStore(document).store });
  assert.ok(ok.ok && ok.data.status === "ok");

  const broken = fakeStore({ ...(document as unknown as OnboardingDocument), welcome: { ...(document as unknown as OnboardingDocument).welcome, enabled: "yes" } as unknown as OnboardingValues["welcome"] });
  const invalid = await readOnboarding({ session: validSession(), guilds: maintainGuild(), guildId: GUILD_ID, store: broken.store });
  assert.ok(invalid.ok);
  assert.equal(invalid.data.status, "invalid");
});

test("read denies unauthorized callers before touching storage", async () => {
  const { store, calls } = fakeStore();
  const denied = await readOnboarding({
    session: validSession(),
    guilds: [{ id: "223456789012345678", name: "Elsewhere", icon: null, owner: false, permissions: "32" }],
    guildId: GUILD_ID,
    store,
  });
  assert.equal(denied.ok, false);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Route wiring guards.
// ---------------------------------------------------------------------------

test("route wires the shared handler with the onboarding limiter", () => {
  const route = readFileSync(resolve(SOURCE_ROOT, "src/app/api/config/[guildId]/onboarding/route.ts"), "utf8");
  assert.match(route, /export async function PATCH/);
  assert.equal(route.includes("export async function POST"), false, "PATCH is the only mutating verb");
  assert.match(route, /onboardingRateLimiter/);
  assert.match(route, /handleOnboarding/);
  assert.match(route, /Cache-Control": "no-store/);
});

// ---------------------------------------------------------------------------
// Bot/website validator parity — the real bot modules run offline against
// the same fixtures (in-memory repositories only; no database, no Discord).
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const botValidation = require("../../src/onboarding/validation.js") as {
  validateOnboardingValues: (input: unknown) => { ok: boolean; errors?: { path: string; message: string }[] };
};
const botService = require("../../src/onboarding/service.js") as {
  createOnboardingService: (options: { getRepositories: () => unknown; logger?: unknown }) => {
    getOnboarding(args: { guildId: string }): Promise<Record<string, unknown> | null>;
    saveOnboarding(args: { guildId: string; values: unknown; expectedRevision: number }): Promise<{ ok: boolean; code?: string }>;
  };
};

function enabledWelcomeConfig() {
  return {
    welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel", mention: true, design: simpleDesign("text"), card: null, cardEnabled: false },
    goodbye: { enabled: false, channelId: null, design: null },
    autoRoles: { enabled: false, roleIds: [], skipBots: true },
    joinLogChannelId: null,
  };
}

test("bot and website validators agree on the same fixtures", () => {
  const invalidDesignContainerSibling = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "cs", components: [{ key: "k", kind: "container", components: [{ key: "t", kind: "textDisplay", content: "x" }] }, { key: "t2", kind: "textDisplay", content: "y" }] } } };
  const invalidNestedContainer = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "n", components: [{ key: "k", kind: "container", components: [{ key: "i", kind: "container", components: [{ key: "t", kind: "textDisplay", content: "x" }] }] }] } } };
  const validContainerWrapper = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "c", components: [{ key: "k", kind: "container", accentColor: 0x5865f2, spoiler: false, components: [{ key: "t", kind: "textDisplay", content: "x" }] }] } } };
  const validAvatarGreeting = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "av", components: [{ key: "g", kind: "section", components: [{ key: "t", kind: "textDisplay", content: "hi" }], accessory: { key: "th", kind: "thumbnail", url: "attachment://member-avatar.png" } }] } } };
  const invalidButtonStyle = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "b", components: [{ key: "r", kind: "actionRow", components: [{ key: "x", kind: "button", style: 1, label: "Open", customId: "open" }] }] } } };
  const invalidSelect = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "s", components: [{ key: "r", kind: "actionRow", components: [{ key: "s", kind: "stringSelect", customId: "s", options: [{ label: "a", value: "a" }] }] }] } } };
  const invalidAttachment = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "a", components: [{ key: "g", kind: "mediaGallery", items: [{ url: "attachment://other.png" }] }] } } };
  const invalidRoles = { ...enabledWelcomeConfig(), autoRoles: { enabled: true, roleIds: ["bad"], skipBots: true } };
  const invalidEnabledNoChannel = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, channelId: null } };
  const invalidCard = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, card: { preset: "nope" } } };
  const invalidTooManyText = { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: { name: "t", components: [{ key: "x", kind: "textDisplay", content: "y".repeat(4001) }] } } };
  const roleSelectBase = () => enabledWelcomeConfig();
  const validRoleSelect = { ...roleSelectBase(), welcome: { ...roleSelectBase().welcome, roleSelect: { enabled: true, prompt: "Pick a role", roleIds: [ROLE_ID] } } };
  const invalidRoleSelectNoRoles = { ...roleSelectBase(), welcome: { ...roleSelectBase().welcome, roleSelect: { enabled: true, prompt: "Pick", roleIds: [] } } };
  const invalidRoleSelectBadId = { ...roleSelectBase(), welcome: { ...roleSelectBase().welcome, roleSelect: { enabled: false, prompt: "", roleIds: ["bad"] } } };

  const fixtures: [string, Record<string, unknown>, boolean][] = [
    ["disabled default", fullConfig(), true],
    ["enabled welcome", enabledWelcomeConfig(), true],
    ["card design", { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: simpleDesign("card") } }, true],
    ["link buttons", { ...enabledWelcomeConfig(), welcome: { ...enabledWelcomeConfig().welcome, design: simpleDesign("linkButton") } }, true],
    ["container wrapper", validContainerWrapper, true],
    ["avatar greeting", validAvatarGreeting, true],
    ["container with sibling block", invalidDesignContainerSibling, false],
    ["nested container", invalidNestedContainer, false],
    ["interaction button", invalidButtonStyle, false],
    ["select", invalidSelect, false],
    ["foreign attachment", invalidAttachment, false],
    ["bad role ids", invalidRoles, false],
    ["enabled without channel", invalidEnabledNoChannel, false],
    ["bad card", invalidCard, false],
    ["oversized text", invalidTooManyText, false],
    ["role select valid", validRoleSelect, true],
    ["role select enabled without roles", invalidRoleSelectNoRoles, false],
    ["role select bad id", invalidRoleSelectBadId, false],
  ];
  for (const [name, fixture, expectedOk] of fixtures) {
    const website = validateOnboarding(fixture);
    const bot = botValidation.validateOnboardingValues(fixture);
    assert.equal(website.issues.length === 0, expectedOk, `website agrees on ${name}`);
    assert.equal(bot.ok, expectedOk, `bot agrees on ${name}`);
    assert.equal(website.issues.length === 0, bot.ok, `parity holds for ${name}`);
  }
});

test("bot onboarding service revalidates and CASes through the repository", async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const repositories = {
    onboarding: {
      async get(guildId: string) { return stored.get(guildId) ?? null; },
      async compareAndSet(guildId: string, values: Record<string, unknown>, expectedRevision: number) {
        const current = stored.get(guildId);
        if (expectedRevision === 0) {
          if (current) return null;
          stored.set(guildId, { guildId, revision: 1, ...values });
          return stored.get(guildId)!;
        }
        if (!current || current.revision !== expectedRevision) return null;
        stored.set(guildId, { guildId, revision: expectedRevision + 1, ...values });
        return stored.get(guildId)!;
      },
    },
  };
  const logger = { warn: () => {} };
  const service = botService.createOnboardingService({ getRepositories: () => repositories, logger });

  const missing = await service.getOnboarding({ guildId: GUILD_ID });
  assert.equal(missing, null, "reads never provision");

  const rejected = await service.saveOnboarding({ guildId: GUILD_ID, values: { welcome: 1 }, expectedRevision: 0 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "ONBOARDING_INVALID");
  assert.equal(stored.size, 0, "a rejected save writes nothing");

  const created = await service.saveOnboarding({ guildId: GUILD_ID, values: validateOnboarding(fullConfig()).values, expectedRevision: 0 });
  assert.equal(created.ok, true);
  const stale = await service.saveOnboarding({ guildId: GUILD_ID, values: validateOnboarding(fullConfig()).values, expectedRevision: 0 });
  assert.equal(stale.code, "ONBOARDING_STALE");

  const advanced = await service.saveOnboarding({ guildId: GUILD_ID, values: validateOnboarding(fullConfig()).values, expectedRevision: 1 });
  assert.equal(advanced.ok, true);
  assert.equal(stored.get(GUILD_ID)?.revision, 2);
});

test("bot service propagates storage failures instead of hiding them", async () => {
  const service = botService.createOnboardingService({
    getRepositories: () => ({}),
    logger: { warn: () => {} },
  });
  await assert.rejects(() => service.getOnboarding({ guildId: GUILD_ID }));
  const failed = await service.saveOnboarding({ guildId: GUILD_ID, values: validateOnboarding(fullConfig()).values, expectedRevision: 0 });
  assert.equal(failed.code, "REPOSITORY_UNAVAILABLE");
});

test("bot payload builder and the Studio mapper produce identical API JSON", async () => {
  const botPayload = require("../../src/onboarding/payload.js") as {
    buildOnboardingPayload: (design: unknown, values: Record<string, unknown>, options?: Record<string, unknown>) => { components: unknown[]; flags: number } | null;
    designReferences: (design: unknown, url: string) => boolean;
  };
  const { buildMessagePayload } = await import("../src/lib/component-v2");
  const shared = {
    key: "d", name: "parity",
    components: [
      { key: "t", kind: "textDisplay", content: "Welcome aboard!" },
      { key: "r", kind: "actionRow", components: [
        { key: "b", kind: "button", style: 5, label: "Rules", url: "https://example.com/rules", disabled: true },
      ] },
      { key: "g", kind: "mediaGallery", items: [{ url: "https://cdn.example.com/a.png", description: "art", spoiler: true }] },
      { key: "s", kind: "separator", divider: true, spacing: 2 },
      { key: "sec", kind: "section", components: [{ key: "st", kind: "textDisplay", content: "read the rules" }], accessory: { key: "th", kind: "thumbnail", url: "https://cdn.example.com/t.png" } },
      // Container wrapper plus the member-avatar reference: the two shapes
      // added by the container/avatar pass, mapped identically on both sides.
      { key: "cont", kind: "container", accentColor: 0x5865f2, spoiler: false, components: [
        { key: "ct", kind: "textDisplay", content: "inside the container" },
        { key: "csec", kind: "section", components: [{ key: "cst", kind: "textDisplay", content: "Welcome aboard!" }], accessory: { key: "cth", kind: "thumbnail", url: "attachment://member-avatar.png" } },
      ] },
    ],
  };
  const values = { username: "x", userId: USER_ID, guildName: "g", memberCount: 1, mentionEnabled: false };
  const bot = botPayload.buildOnboardingPayload(shared, values, { cardAvailable: false, avatarAvailable: true });
  const website = buildMessagePayload(shared as never);
  assert.ok(bot, "the bot maps the shared design");
  assert.deepEqual(bot, website);

  // An empty container maps to nothing (so the message is skipped rather than
  // sending an empty box). Without the attached file the avatar reference is
  // dropped, and the greeting falls back to its text instead of vanishing.
  const withContainer = { key: "d", name: "x", components: [{ key: "c", kind: "container", components: [] }] };
  assert.equal(botPayload.buildOnboardingPayload(withContainer, values), null);
  const avatarRef = {
    key: "d",
    name: "av",
    components: [{ key: "s", kind: "section", components: [{ key: "t", kind: "textDisplay", content: "hi" }], accessory: { key: "th", kind: "thumbnail", url: "attachment://member-avatar.png" } }],
  };
  assert.deepEqual(botPayload.buildOnboardingPayload(avatarRef, values, { avatarAvailable: false }), {
    components: [{ type: 10, content: "hi" }],
    flags: 32768,
  });
  const shipped = botPayload.buildOnboardingPayload(avatarRef, values, { avatarAvailable: true });
  assert.ok(shipped, "with the file attached the section ships whole");
  assert.equal((shipped?.components[0] as { type: number }).type, 9);
  assert.equal(botPayload.designReferences(avatarRef, "attachment://member-avatar.png"), true);
  assert.equal(botPayload.designReferences(withContainer, "attachment://member-avatar.png"), false);
});

// ---------------------------------------------------------------------------
// P5 — editor page wiring and the client-safe save model.
// ---------------------------------------------------------------------------

test("onboarding editor pages are registered routes in the navigation group", () => {
  const sections = readSource("src/lib/dashboard-sections.ts");
  assert.match(sections, /id: "welcome",[\s\S]*label: "Welcome Messages"/);
  assert.match(sections, /id: "auto-roles",[\s\S]*label: "Auto Roles"/);
  const onboardingGroup = sections.slice(sections.indexOf('id: "onboarding"'));
  assert.match(onboardingGroup, /sectionIds: \["component-studio", "welcome", "goodbye", "auto-roles"\]/);
  const page = readSource("src/app/dashboard/[guildId]/[section]/page.tsx");
  assert.match(page, /section\.id === "welcome" \|\| section\.id === "goodbye" \|\| section\.id === "auto-roles"/);
  assert.match(page, /readOnboarding\(\{ session, guilds, guildId: guild\.id \}\)/);
  // Server reads the live directories; the client islands never fetch them.
  assert.match(page, /getGuildChannels/);
  assert.match(page, /getGuildRoles/);
});

test("client editor components never reach the server config layer", () => {
  for (const file of [
    "src/components/dashboard/WelcomeSettingsContent.tsx",
    "src/components/dashboard/AutoRolesContent.tsx",
    "src/lib/onboarding-blocks.ts",
    "src/lib/onboarding-design.ts",
    "src/lib/onboarding-preview.ts",
  ]) {
    const source = readSource(file);
    assert.match(source, /"use client"|client-safe/, `${file} declares its side`);
    assert.equal(/from "@\/lib\/config\//.test(source), false, `${file} must not import lib/config`);
    assert.equal(/lib\/botPresence/.test(source), false, `${file} must not import server presence readers`);
  }
});

test("container wrap/unwrap round-trips without ever nesting", async () => {
  const { splitWelcomeContainer, joinWelcomeContainer, isAvatarBlock, isCardSlotBlock, buildAvatarGreeting } =
    await import("../src/lib/onboarding-design");
  const flat = { key: "d", name: "welcome", components: [{ key: "t", kind: "textDisplay", content: "hi" }] } as never;

  // A flat design stays flat; a wrapped design unwraps to the same blocks.
  assert.equal(splitWelcomeContainer(flat).container.enabled, false);
  const wrapped = joinWelcomeContainer(flat, { enabled: true, accentColor: 0x22d3ee });
  assert.equal(wrapped.components.length, 1);
  const back = splitWelcomeContainer(wrapped as never);
  assert.equal(back.container.enabled, true);
  assert.equal(back.container.accentColor, 0x22d3ee);
  assert.deepEqual(back.design?.components.map((node) => node.key), ["t"]);

  // Nothing to wrap stays flat, so an empty container is never stored.
  const empty = { key: "d", name: "welcome", components: [] } as never;
  assert.equal(joinWelcomeContainer(empty, { enabled: true, accentColor: null }).components.length, 0);

  const greeting = buildAvatarGreeting("## Welcome {user}!", "-# {memberCount}");
  assert.equal(isAvatarBlock(greeting), true);
  assert.equal(isCardSlotBlock(greeting), false);
});

test("welcome editor offers the container style and the avatar greeting", () => {
  const page = readSource("src/components/dashboard/WelcomeSettingsContent.tsx");
  assert.match(page, /Show as a container/);
  assert.match(page, /splitWelcomeContainer[\s\S]*joinWelcomeContainer/, "the editor unwraps on load and rewraps on save");
  assert.match(page, /Greeting with avatar/);
  assert.match(page, /AvatarGreetingMock/, "the preview shows an avatar, never a gray attachment box");
  assert.match(page, /member-avatar|AVATAR_ATTACHMENT_URL/, "the greeting references the member avatar attachment");
});

test("onboarding blocks carry the untouched halves and map save outcomes", async () => {
  const blocks = await import("../src/lib/onboarding-blocks");
  const initial = blocks.blocksFromDocument(null);
  assert.equal(initial.welcome.enabled, false);
  assert.deepEqual(initial.autoRoles.roleIds, []);

  const carried = blocks.blocksFromDocument({
    guildId: GUILD_ID,
    revision: 7,
    updatedAt: "",
    welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel", mention: false, cardEnabled: false, design: { components: [] }, card: null },
    goodbye: { enabled: false, channelId: null, design: null },
    autoRoles: { enabled: true, roleIds: [ROLE], skipBots: false },
    joinLogChannelId: null,
  });
  assert.deepEqual(carried.autoRoles.roleIds, [ROLE], "the roles page state survives a welcome-page save");

  const body = blocks.buildOnboardingSaveBody(carried, 7);
  assert.deepEqual(Object.keys(body).sort(), ["autoRoles", "expectedRevision", "goodbye", "joinLogChannelId", "welcome"]);
  assert.equal(body.expectedRevision, 7);

  // postOnboardingSave maps every route outcome without leaking payloads.
  const jsonResponse = (status: number, payload: unknown) => ({
    status,
    json: async () => payload,
  });
  const route = async (status: number, payload: unknown) =>
    blocks.postOnboardingSave(GUILD_ID, body, (async () => jsonResponse(status, payload)) as unknown as typeof fetch);

  assert.equal((await route(200, { onboarding: { revision: 8 } })).kind, "saved");
  const invalid = await route(400, { error: "invalid-config", issues: [{ path: "welcome.channelId", message: "needs a channel" }] });
  assert.equal(invalid.kind, "invalid");
  assert.equal((await route(409, { error: "stale-revision" })).kind, "stale");
  assert.equal((await route(429, { error: "rate-limited" })).kind, "unavailable");
  assert.match(blocks.describeSaveError("rate-limited"), /minute/);
  assert.match(blocks.describeSaveError("weird"), /Nothing was changed/);
});

test("a stale save recovers by keeping this page's block and refreshing the rest", async () => {
  const blocks = await import("../src/lib/onboarding-blocks");
  const won = {
    guildId: GUILD_ID,
    revision: 9,
    updatedAt: new Date().toISOString(),
    welcome: { enabled: true, channelId: CHANNEL_ID, mode: "channel" as const, mention: true, cardEnabled: false, design: null, card: null },
    goodbye: { enabled: false, channelId: null, design: null },
    autoRoles: { enabled: false, roleIds: [], skipBots: true },
    joinLogChannelId: CHANNEL_ID,
  };
  // The roles page loaded at revision 4, when welcome was still switched off.
  const local = blocks.blocksFromDocument({ ...won, revision: 4, welcome: { ...won.welcome, enabled: false, mention: false } });
  local.autoRoles = { enabled: true, roleIds: [ROLE], skipBots: false };

  const merged = blocks.reconcileStaleBlocks(local, won, ["autoRoles"]);
  assert.deepEqual(merged.autoRoles, { enabled: true, roleIds: [ROLE], skipBots: false }, "the operator's own choices survive");
  assert.equal(merged.welcome.enabled, true, "a block someone else changed is refreshed, not reverted");
  assert.equal(merged.welcome.mention, true);
  assert.equal(merged.joinLogChannelId, CHANNEL_ID);

  // The retry posts the winning document plus this page's block, at the new revision.
  const retry = blocks.buildOnboardingSaveBody(merged, won.revision);
  assert.equal(retry.expectedRevision, 9);
  assert.deepEqual(retry.welcome, won.welcome);
  assert.deepEqual(retry.autoRoles.roleIds, [ROLE]);

  // A page owning several blocks keeps exactly those.
  const welcomeOwned = blocks.reconcileStaleBlocks(
    { ...local, welcome: { ...won.welcome, enabled: false }, joinLogChannelId: null },
    won,
    ["welcome", "joinLogChannelId"],
  );
  assert.equal(welcomeOwned.welcome.enabled, false, "its own edits are kept");
  assert.equal(welcomeOwned.joinLogChannelId, null);
  assert.deepEqual(welcomeOwned.autoRoles, won.autoRoles, "and the untouched block is not clobbered");

  // postOnboardingSave surfaces the winning document, and stays honest without one.
  const jsonResponse = (status: number, payload: unknown) => ({ status, json: async () => payload });
  const call = (payload: unknown) =>
    blocks.postOnboardingSave(GUILD_ID, retry, (async () => jsonResponse(409, payload)) as unknown as typeof fetch);

  const withDocument = await call({ error: "stale-revision", onboarding: won });
  if (withDocument.kind !== "stale") throw new Error(`expected stale, got ${withDocument.kind}`);
  assert.equal(withDocument.document?.revision, 9, "the editor can adopt the returned revision");

  const withoutDocument = await call({ error: "stale-revision" });
  if (withoutDocument.kind !== "stale") throw new Error(`expected stale, got ${withoutDocument.kind}`);
  assert.equal(withoutDocument.document, null, "never a fabricated document");
});

test("welcome conflicts warn on overlapping targets but never block a clean config", async () => {
  const blocks = await import("../src/lib/onboarding-blocks");
  const base = blocks.blocksFromDocument(null);
  // A clean, single-channel welcome with a separate log warns about nothing.
  const clean = { ...base, welcome: { ...base.welcome, enabled: true, channelId: CHANNEL_ID } };
  assert.deepEqual(blocks.welcomeConflicts(clean), []);

  // Greeting and join log share one channel -> exactly one advisory.
  const sharedLog = { ...clean, joinLogChannelId: CHANNEL_ID };
  const logConflicts = blocks.welcomeConflicts(sharedLog);
  assert.equal(logConflicts.length, 1);
  assert.equal(logConflicts[0].path, "joinLogChannelId");

  // An enabled card plus a delivery block: the delivery is silently unused.
  const cardOverridesDelivery = {
    ...clean,
    welcome: {
      ...clean.welcome,
      cardEnabled: true,
      card: { preset: "river-1" },
      delivery: { textEnabled: true, template: "hi", destination: "channel" as const, imageMode: "with_text" as const, imageChannelId: null },
    },
  };
  assert.ok(blocks.welcomeConflicts(cardOverridesDelivery).some((i) => i.path === "welcome.delivery"));

  // Disabled welcome -> no noise, mirroring "nothing is sent, nothing to warn about".
  assert.deepEqual(blocks.welcomeConflicts(base), []);
});

test("welcome and auto-roles editors render offline with honest defaults", async () => {
  (globalThis as Record<string, unknown>).React = ReactNamespace;
  const { WelcomeSettingsContent } = await import(
    "../src/components/dashboard/WelcomeSettingsContent"
  );
  const { AutoRolesContent } = await import("../src/components/dashboard/AutoRolesContent");
  const welcomeHtml = renderToStaticMarkup(
    createElement(WelcomeSettingsContent, {
      guildId: GUILD_ID,
      document: null,
      channels: [{ id: CHANNEL_ID, name: "general" }],
    }),
  );
  assert.match(welcomeHtml, /nothing is sent when members join/i);
  assert.match(welcomeHtml, /Preview as Discord/);
  assert.match(welcomeHtml, /Your blocks appear here as you build them/);
  assert.match(welcomeHtml, /Save welcome settings/);
  assert.match(welcomeHtml, /actual send are verified by Nila at join time/);
  // The honest boundary: enabling without a channel is flagged before save.
  assert.equal(welcomeHtml.includes("https://example.com"), false);
  const offlineChannelHtml = renderToStaticMarkup(createElement(WelcomeSettingsContent, {
    guildId: GUILD_ID, document: null, channels: [], channelsAvailable: false,
  }));
  assert.match(offlineChannelHtml, /live channel directory is unavailable/i);
  assert.match(offlineChannelHtml, /disabled=""/);

  const rolesHtml = renderToStaticMarkup(
    createElement(AutoRolesContent, { guildId: GUILD_ID, document: null, roles: [], rolesAvailable: true }),
  );
  assert.match(rolesHtml, /Assign roles on join/);
  assert.match(rolesHtml, /No assignable roles are available/);
  const rolesOfflineHtml = renderToStaticMarkup(createElement(AutoRolesContent, {
    guildId: GUILD_ID,
    document: null,
    roles: [],
    rolesAvailable: false,
  }));
  assert.match(rolesOfflineHtml, /role directory is unavailable/i);
});

test("welcome editor renders the role picker, recent-joins history, and honest empty state", async () => {
  (globalThis as Record<string, unknown>).React = ReactNamespace;
  const { WelcomeSettingsContent } = await import("../src/components/dashboard/WelcomeSettingsContent");
  const base = { guildId: GUILD_ID, document: null, channels: [{ id: CHANNEL_ID, name: "general" }] };

  // Empty history reads honestly rather than inventing a state.
  const empty = renderToStaticMarkup(createElement(WelcomeSettingsContent, { ...base, roles: [], rolesAvailable: false, recentJoins: [] }));
  assert.match(empty, /Recent joins/);
  assert.match(empty, /No joins recorded yet/);
  assert.match(empty, /Let new members pick a role/);

  // A delivered and a failed join both surface with their honest outcome, and
  // an enabled picker lists the allowlisted roles from the live directory.
  const populated = renderToStaticMarkup(createElement(WelcomeSettingsContent, {
    ...base,
    document: {
      guildId: GUILD_ID, revision: 1, updatedAt: new Date().toISOString(),
      welcome: { enabled: false, channelId: null, mode: "channel", mention: false, cardEnabled: false, design: null, card: null, roleSelect: { enabled: true, prompt: "Pick a role", roleIds: [ROLE_ID] } },
      goodbye: { enabled: false, channelId: null, design: null },
      autoRoles: { enabled: false, roleIds: [], skipBots: true },
      joinLogChannelId: null,
    },
    roles: [{ id: ROLE_ID, name: "Regular", color: 0x5865f2 }],
    rolesAvailable: true,
    recentJoins: [
      { memberId: "223456789012345678", username: "nova", action: "welcomed", reason: "", deliveredTo: "#welcome", notes: [], cardWarnings: [], recordedAt: new Date().toISOString() },
      { memberId: null, username: "sam", action: "failed", reason: "Nila cannot send", deliveredTo: "", notes: [], cardWarnings: [], recordedAt: new Date().toISOString() },
    ],
  }));
  assert.match(populated, />welcomed</);
  assert.match(populated, />failed</);
  assert.match(populated, /cannot send/i);
  assert.ok(!/No joins recorded yet/.test(populated));

  // The picker list offers allowlisted roles when the directory is live.
  assert.match(populated, /Regular/);
});

// ---------------------------------------------------------------------------
// P4 — card designer, background upload flow.
// ---------------------------------------------------------------------------

test("card designer uses the exact card image as its editable surface", async () => {
  (globalThis as Record<string, unknown>).React = ReactNamespace;
  const { WelcomeCardDesigner, DEFAULT_CARD } = await import(
    "../src/components/dashboard/WelcomeCardDesigner"
  );
  const html = renderToStaticMarkup(
    createElement(WelcomeCardDesigner, { card: DEFAULT_CARD, onChange: () => {}, guildId: GUILD_ID, exactPreview: { previewUrl: null, state: "loading" } }),
  );
  assert.match(html, /Rendering the card sent by Nila/);
  assert.match(html, /Exact card render · sample: nova, your server, 128 members/);
  assert.doesNotMatch(html, /Preview real card|Live Nila render/);
  assert.match(html, /Avatar position \(drag, or use arrow keys\)/);
  assert.match(html, /Upload background/);
  assert.match(html, /river-1|Nila river/);
  assert.match(html, /Text lines \(2\/4\)/);
  assert.match(html, /Remove card/);
});

test("welcome page offers the card and wires the attachment slot", () => {
  const source = readSource("src/components/dashboard/WelcomeSettingsContent.tsx");
  assert.match(source, /Add a welcome card/);
  assert.match(source, /WelcomeCardDesigner/);
  assert.match(source, /CARD_ATTACHMENT_URL/);
});

test("card slot requests the exact Nila PNG preview, never a CSS text approximation", async () => {
  (globalThis as Record<string, unknown>).React = ReactNamespace;
  const { CardMock, DEFAULT_CARD } = await import(
    "../src/components/dashboard/WelcomeCardDesigner"
  );
  const html = renderToStaticMarkup(createElement(CardMock, { card: DEFAULT_CARD, preview: { previewUrl: null, state: "loading" } }));
  assert.match(html, /Rendering exact card preview/);
  const designer = readSource("src/components/dashboard/WelcomeCardDesigner.tsx");
  assert.match(designer, /onboarding\/card-preview/);
  assert.match(designer, /Background link:/, "a pasted link is offered next to the file picker");
  assert.match(designer, /createSampleCardValues\(guildName, channelName\)/);
  assert.match(designer, /Exact rendered welcome card preview/);
  assert.match(designer, /one shared, server-rendered PNG feeds both the editor and Discord message preview/i);
  assert.match(designer, /\}, 500\)/, "refreshes shortly after edits pause");
  assert.doesNotMatch(designer, /Updating exact (?:preview|card)/, "keeps refreshes visually quiet");
  assert.match(designer, /Keep the last good frame visible during transient render\/network/);
  assert.doesNotMatch(designer, /fontSize:.*sizePct/);
  const page = readSource("src/components/dashboard/WelcomeSettingsContent.tsx");
  assert.doesNotMatch(page, /ProBot/i, "no third-party branding in our UI copy");
  assert.match(page, /useExactCardPreview\(/, "the editor owns one exact render shared with the message preview");
  assert.match(page, /CardMock card=\{blocks\.welcome\.card as CardConfig\} preview=\{exactCardPreview\}/);
});

test("onboarding pages use the studio workspace layout: two columns, sticky preview, status pill", () => {
  const welcome = readSource("src/components/dashboard/WelcomeSettingsContent.tsx");
  const goodbye = readSource("src/components/dashboard/GoodbyeContent.tsx");
  const autoRoles = readSource("src/components/dashboard/AutoRolesContent.tsx");
  for (const [name, body, grid] of [
    ["welcome", welcome, /xl:grid-cols-\[minmax\(0,3fr\)_minmax\(340px,2fr\)\]/],
    ["goodbye", goodbye, /lg:grid-cols-\[minmax\(0,3fr\)_minmax\(340px,2fr\)\]/],
  ] as const) {
    assert.ok(grid.test(body), `${name} must render settings and preview as two desktop columns`);
    // Same phone regression as the Studio: the base track must be minmax(0,1fr).
    assert.ok(/grid-cols-\[minmax\(0,1fr\)\]/.test(body), `${name} must keep a minmax(0,1fr) base track for phones`);
    assert.ok(/xl:sticky|lg:sticky/.test(body), `${name} must keep the preview column visible while editing`);
  }
  for (const [name, body] of [["welcome", welcome], ["goodbye", goodbye], ["auto-roles", autoRoles]] as const) {
    assert.ok(/Active|Off/.test(body) && /rounded-full border/.test(body), `${name} must show a live status pill`);
  }
  assert.match(welcome, /1 · Settings[\s\S]*2 · Welcome card[\s\S]*3 · Message/, "the welcome page keeps its numbered step flow");
});

test("upload decoding is exact: type, size, and strict base64", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const dataBase64 = Buffer.from(bytes).toString("base64");
  const ok = decodeOnboardingUpload({ dataBase64, contentType: "image/png" });
  assert.equal(ok.ok, true);
  assert.equal(decodeOnboardingUpload({ dataBase64, contentType: "image/svg+xml" }).ok, false);
  assert.equal(decodeOnboardingUpload({ dataBase64: "not!base64", contentType: "image/png" }).ok, false);
  assert.equal(decodeOnboardingUpload({ dataBase64: "", contentType: "image/png" }).ok, false);
  assert.equal(decodeOnboardingUpload({ dataBase64, contentType: "image/png", extra: 1 }).ok, false);
  assert.equal(decodeOnboardingUpload(null).ok, false);
});

test("an animated GIF background is accepted with its own budget", () => {
  const gif = new Uint8Array(32);
  gif.set(Buffer.from("GIF89a", "ascii"), 0);
  const dataBase64 = Buffer.from(gif).toString("base64");
  const ok = decodeOnboardingUpload({ dataBase64, contentType: "image/gif" });
  assert.equal(ok.ok, true, "a real GIF header is accepted");
  assert.ok(ok.ok && ok.contentType === "image/gif");

  // Mislabeled bytes never reach storage: the label alone is not enough.
  const notGif = Buffer.from(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).toString("base64");
  assert.equal(decodeOnboardingUpload({ dataBase64: notGif, contentType: "image/gif" }).ok, false);

  // The still formats keep the 3 MB ceiling; only GIF gets the bigger one.
  assert.equal(onboardingUploadBudget("image/png"), 3 * 1024 * 1024);
  assert.equal(onboardingUploadBudget("image/jpeg"), 3 * 1024 * 1024);
  assert.equal(onboardingUploadBudget("image/gif"), 10 * 1024 * 1024);
  assert.equal(ONBOARDING_UPLOAD_MAX_GIF_BYTES, 10 * 1024 * 1024, "GIFs are capped at Discord's own attachment limit");
});

test("background links are parsed strictly and only point at public hosts", () => {
  for (const url of [
    "https://s15.gifyu.com/images/bcpD3.gif",
    "https://files.catbox.moe/abc.gif",
    "https://media.giphy.com/media/x/giphy.gif",
    "https://cdn.tenor.com/abc/Name.gif",
    "https://i.imgur.com/x.png",
    "https://cdn.discordapp.com/attachments/1/2/card.gif?ex=1&is=2&hm=3",
    "https://cdn.example.com/welcome/bg.gif",
  ]) {
    assert.equal(parseUploadSourceUrl({ url }).ok, true, `${url} must be allowed`);
  }
  for (const url of [
    "http://s15.gifyu.com/images/bcpD3.gif",
    "https://s15.gifyu.com:8443/x.gif",
    "https://user:pass@s15.gifyu.com/x.gif",
    "https://localhost/x.gif",
    "https://api.localhost/x.gif",
    "https://metadata.google.internal/x.gif",
    "https://127.0.0.1/x.gif",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x.gif",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(parseUploadSourceUrl({ url }).ok, false, `${url} must be refused`);
  }
  const parsed = parseUploadSourceUrl({ url: "https://s15.gifyu.com/images/bcpD3.gif" });
  assert.equal(parsed.ok && parsed.host, "s15.gifyu.com", "the host is reported for the address check");
  assert.equal(parseUploadSourceUrl({ url: "https://media.giphy.com/x.gif", contentType: "image/gif" }).ok, false, "the body shape stays exact");
  assert.equal(parseUploadSourceUrl({ dataBase64: "AA==", contentType: "image/png" }).ok, false);
  assert.equal(parseUploadSourceUrl({ url: `https://media.giphy.com/${"x".repeat(3000)}` }).ok, false);
  assert.equal(parseUploadSourceUrl(null).ok, false);
});

test("a link is downloaded once, bounded, and typed by its bytes", async () => {
  const gif = new Uint8Array(32);
  gif.set(Buffer.from("GIF89a", "ascii"), 0);
  const html = new Uint8Array(Buffer.from("<!doctype html><title>nope</title>", "utf8"));
  const respond = (init: { status?: number; type?: string; bytes?: Uint8Array; length?: number }) => {
    const headers = new Map<string, string>();
    if (init.type) headers.set("content-type", init.type);
    if (init.length !== undefined) headers.set("content-length", String(init.length));
    const chunks = [init.bytes ?? gif];
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: {
        getReader: () => {
          let at = 0;
          return {
            read: async () => (at < chunks.length ? { done: false, value: chunks[at++] } : { done: true }),
            cancel: async () => {},
          };
        },
      },
      arrayBuffer: async () => Buffer.concat(chunks),
    } as unknown as Response;
  };
  const asFetch = (impl: () => Promise<Response>) => impl as unknown as typeof fetch;
  /** Offline stand-in for the resolver the route wires in. */
  const publicResolver = async () => [{ address: "93.184.216.34" }];
  const privateResolver = async () => [{ address: "10.0.0.5" }];
  const link = { url: "https://s15.gifyu.com/images/bcpD3.gif" };

  const ok = await importOnboardingUpload(link, asFetch(async () => respond({ type: "image/gif" })), publicResolver);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.contentType, "image/gif");
  assert.equal(ok.ok && ok.image.byteLength, gif.byteLength);

  const octet = await importOnboardingUpload(link, asFetch(async () => respond({ type: "application/octet-stream" })), publicResolver);
  assert.equal(octet.ok && octet.contentType, "image/gif", "the bytes decide when the header is generic");

  const wrongType = await importOnboardingUpload(link, asFetch(async () => respond({ type: "text/html; charset=utf-8", bytes: html })), publicResolver);
  assert.equal(wrongType.ok === false && wrongType.reason, "invalid");

  const oversized = await importOnboardingUpload(
    link,
    asFetch(async () => respond({ type: "image/gif", length: ONBOARDING_UPLOAD_MAX_GIF_BYTES + 1 })),
    publicResolver,
  );
  assert.equal(oversized.ok === false && oversized.reason, "invalid");

  const missing = await importOnboardingUpload(link, asFetch(async () => respond({ status: 404, type: "image/gif" })), publicResolver);
  assert.equal(missing.ok === false && missing.reason, "unavailable");

  const down = await importOnboardingUpload(link, asFetch(async () => { throw new Error("network down"); }), publicResolver);
  assert.equal(down.ok === false && down.reason, "unavailable");

  const noResolver = await importOnboardingUpload(link, asFetch(async () => respond({ type: "image/gif" })));
  assert.equal(noResolver.ok === false && noResolver.reason, "unavailable", "without an address check there is no download");

  const unresolvable = await importOnboardingUpload(
    link,
    asFetch(async () => respond({ type: "image/gif" })),
    async () => { throw new Error("ENOTFOUND"); },
  );
  assert.equal(unresolvable.ok === false && unresolvable.reason, "unavailable");

  let fetched = 0;
  const offsite = await importOnboardingUpload(
    { url: "https://internal.example/x.gif" },
    asFetch(async () => { fetched += 1; return respond({ type: "image/gif" }); }),
    privateResolver,
  );
  assert.equal(offsite.ok === false && offsite.reason, "invalid", "a private address is refused");
  assert.equal(fetched, 0, "a refused host is never fetched");
});

test("the upload handler stores a linked background or reports the link", async () => {
  const stored: { contentType: string; bytes: number }[] = [];
  const store = {
    async get() { return null; },
    async saveCas() { return { ok: false as const, reason: "storage-error" as const }; },
    async saveUpload(args: { image: Uint8Array; contentType: string }) {
      stored.push({ contentType: args.contentType, bytes: args.image.byteLength });
      return { ok: true as const };
    },
  };
  const gif = new Uint8Array(32);
  gif.set(Buffer.from("GIF89a", "ascii"), 0);
  const base = {
    method: "POST",
    contentType: "application/json",
    guildId: GUILD_ID,
    origin: SITE_URL,
    siteUrl: SITE_URL,
    session: validSession(),
    guilds: maintainGuild(),
    isRateLimited: () => false,
    store,
    newUploadId: () => "b".repeat(32),
    bodyText: JSON.stringify({ url: "https://media.giphy.com/x.gif" }),
  };

  const linked = await handleOnboardingUpload({
    ...base,
    importUpload: async () => ({ ok: true as const, image: gif, contentType: "image/gif" }),
  });
  assert.equal(linked.status, 200);
  assert.equal((linked.body as { contentType?: string }).contentType, "image/gif");
  assert.equal(stored.length, 1, "a link ends up in the same storage as a file");

  const unavailable = await handleOnboardingUpload({
    ...base,
    importUpload: async () => ({ ok: false as const, reason: "unavailable" as const }),
  });
  assert.equal(unavailable.status, 400);
  assert.equal(unavailable.body.error, "source-unavailable");

  const refused = await handleOnboardingUpload({
    ...base,
    importUpload: async () => ({ ok: false as const, reason: "invalid" as const }),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid-upload");
});

test("a file too large for the proxy is accepted in slices", async () => {
  resetOnboardingChunkSessions();
  const stored: { contentType: string; bytes: number }[] = [];
  const store = {
    async get() { return null; },
    async saveCas() { return { ok: false as const, reason: "storage-error" as const }; },
    async saveUpload(args: { image: Uint8Array; contentType: string }) {
      stored.push({ contentType: args.contentType, bytes: args.image.byteLength });
      return { ok: true as const };
    },
  };
  // Three slices' worth of bytes: what a 1 MB proxy would refuse in one body.
  const gif = new Uint8Array(ONBOARDING_CHUNK_BYTES * 2 + 1000);
  gif.set(Buffer.from("GIF89a", "ascii"), 0);
  const encoded = Buffer.from(gif).toString("base64");
  const sliceChars = 512 * 1024;
  const total = Math.ceil(encoded.length / sliceChars);
  assert.equal(total, 3, "the fixture spans three slices");
  const common = {
    method: "POST",
    contentType: "application/json",
    guildId: GUILD_ID,
    origin: SITE_URL,
    siteUrl: SITE_URL,
    session: validSession(),
    guilds: maintainGuild(),
    isRateLimited: () => false,
    store,
    newUploadId: () => "c".repeat(32),
  };
  const post = (body: unknown, session = validSession()) =>
    handleOnboardingUpload({ ...common, session, bodyText: JSON.stringify(body) });
  const slice = (index: number, id?: string, overrides: Record<string, unknown> = {}) => ({
    chunk: {
      id,
      index,
      total,
      dataBase64: encoded.slice(index * sliceChars, (index + 1) * sliceChars),
      contentType: "image/gif",
      ...overrides,
    },
  });

  const first = await post(slice(0));
  assert.equal(first.status, 200);
  const sessionId = (first.body as { chunk?: { id?: string } }).chunk?.id ?? "";
  assert.ok(/^[0-9a-f]{32}$/.test(sessionId), "the first slice starts a session");
  assert.equal(stored.length, 0, "nothing is stored mid-upload");

  assert.equal((await post(slice(1, sessionId), { ...validSession(), user: { ...validSession().user, id: "923456789012345678" } })).status, 400, "another owner cannot append");
  assert.equal((await post(slice(1, "f".repeat(32)))).status, 409, "an unknown session is refused");
  assert.equal((await post(slice(2, sessionId, { dataBase64: "A".repeat(600 * 1024) }))).status, 400, "an oversized slice is refused");
  assert.equal((await post(slice(2, sessionId, { contentType: "image/png" }))).status, 400, "the type cannot change mid-upload");

  assert.equal((await post(slice(1, sessionId))).status, 200);
  const last = await post(slice(2, sessionId));
  assert.equal(last.status, 200);
  const finalBody = last.body as { uploadId?: string; bytes?: number };
  assert.equal(finalBody.uploadId, "c".repeat(32));
  assert.equal(finalBody.bytes, gif.byteLength, "the assembled file is stored whole");
  assert.equal(stored.length, 1, "the slices are assembled and stored once");
  assert.deepEqual(stored[0], { contentType: "image/gif", bytes: gif.byteLength });

  // A fresh session that starts mid-file is a lost client, not a valid upload.
  resetOnboardingChunkSessions();
  assert.equal((await post({ chunk: { index: 1, total: 2, dataBase64: encoded.slice(0, 400), contentType: "image/gif" } })).status, 409);
  // A non-image assembly is refused before storage.
  const junk = Buffer.from("not a gif at all, just text").toString("base64");
  const start = await post({ chunk: { index: 0, total: 1, dataBase64: junk, contentType: "image/gif" } });
  assert.equal(start.status, 400);
  assert.equal(stored.length, 1);
});

test("upload route handler gates like every config mutation", async () => {
  const stored: { uploadId?: string; bytes?: number }[] = [];
  const store = {
    async get() { return null; },
    async saveCas() { return { ok: false as const, reason: "storage-error" as const }; },
    async saveUpload(args: { uploadId: string; image: Uint8Array }) {
      stored.push({ uploadId: args.uploadId, bytes: args.image.byteLength });
      return { ok: true as const };
    },
  };
  const body = JSON.stringify({ dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"), contentType: "image/png" });
  const call = (overrides: Record<string, unknown> = {}) =>
    handleOnboardingUpload({
      method: "POST",
      contentType: "application/json",
      guildId: GUILD_ID,
      origin: SITE_URL,
      siteUrl: SITE_URL,
      bodyText: body,
      session: validSession(),
      guilds: maintainGuild(),
      isRateLimited: () => false,
      store,
      newUploadId: () => "a".repeat(32),
      ...overrides,
    });

  const done = await call();
  assert.equal(done.status, 200);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.bytes, 4);

  assert.equal((await call({ method: "PUT" })).status, 405);
  assert.equal((await call({ origin: "https://evil.example" })).status, 403);
  assert.equal((await call({ guildId: "nope" })).status, 400);
  assert.equal((await call({ isRateLimited: () => true })).status, 429);
  assert.equal((await call({ session: { user: undefined, accessToken: undefined, expiresAt: 0 } })).status, 401);
  assert.equal((await call({ guilds: [] })).status, 403);
  assert.equal((await call({ bodyText: "{" })).status, 400);
  const badUpload = await call({ bodyText: JSON.stringify({ dataBase64: "!!", contentType: "image/png" }) });
  assert.equal(badUpload.status, 400);
});

test("upload route source stays POST-only and no-store", () => {
  const route = readSource("src/app/api/config/[guildId]/onboarding/upload/route.ts");
  assert.match(route, /export async function POST/);
  assert.equal(route.includes("export async function PATCH"), false);
  assert.match(route, /Cache-Control": "no-store/);
  assert.match(route, /randomUUID\(\)\.replaceAll\("-", ""\)/, "ids are server-generated hex");
});

// ---------------------------------------------------------------------------
// P6 — goodbye page and the test-send button.
// ---------------------------------------------------------------------------

test("goodbye page is a registered section wired to the shared onboarding read", () => {
  const sections = readSource("src/lib/dashboard-sections.ts");
  assert.match(sections, /id: "goodbye",[\s\S]*label: "Goodbye Messages"/);
  const page = readSource("src/app/dashboard/[guildId]/[section]/page.tsx");
  assert.match(page, /<LazyDashboardEditor[\s\S]*kind="goodbye"/);
  const lazyEditor = readSource("src/components/dashboard/LazyDashboardEditor.tsx");
  assert.match(lazyEditor, /import\("\.\/GoodbyeContent"\)/);
  assert.match(lazyEditor, /ssr:\s*false/);
});

test("test-send button requires confirmation and blocks drafts from being mistaken for saved tests", async () => {
  const button = readSource("src/components/dashboard/TestSendButton.tsx");
  assert.match(button, /"use client"/);
  assert.match(button, /confirmed: true/);
  assert.match(button, /welcome\.test/);
  assert.match(button, /payload\?\.ok === true/, "success only when the bot confirms");
  assert.match(button, /Confirm test send/);
  assert.match(button, /BRIDGE_NOT_CONFIGURED/);
  assert.match(button, /Save your draft first/);
  const { TestSendButton } = await import("../src/components/dashboard/TestSendButton");
  const unsaved = renderToStaticMarkup(createElement(TestSendButton, { guildId: GUILD_ID, kind: "welcome", hasUnsavedChanges: true }));
  assert.match(unsaved, /Save before test/);
  assert.match(unsaved, /disabled/);
  assert.match(unsaved, /test sends use saved settings/i);
  const welcome = readSource("src/components/dashboard/WelcomeSettingsContent.tsx");
  assert.match(welcome, /<TestSendButton guildId=\{guildId\} kind="welcome" hasUnsavedChanges=\{dirty\} \/>/);
  assert.match(welcome, /disabled=\{saving \|\| !dirty\}/);
  const goodbye = readSource("src/components/dashboard/GoodbyeContent.tsx");
  assert.match(goodbye, /<TestSendButton guildId=\{guildId\} kind="goodbye" hasUnsavedChanges=\{dirty\} \/>/);
  assert.match(readSource("src/components/dashboard/AutoRolesContent.tsx"), /disabled=\{saving \|\| !dirty\}/);
});

test("welcome previews resolve sender tokens for samples without changing saved drafts", () => {
  const template = "{user} {user.mention} {guild} {server} {memberCount} [user] [userName] [user.tag] [user.id] [server] [guild] [channel] [memberCount] [inviter] [inviterName] [unknown]";
  assert.equal(
    previewOnboardingText(template),
    "nova nova Nila Support Server Nila Support Server 128 @nova nova nova 123456789012345678 Nila Support Server Nila Support Server welcome 128 Unknown inviter Unknown [unknown]",
  );
  const draft = { key: "d", name: "draft", components: [{ key: "t", kind: "textDisplay" as const, content: "Welcome {user} to [server]" }] };
  const sample = previewOnboardingDesign(draft);
  assert.equal(sample.components[0].content, "Welcome nova to Nila Support Server");
  assert.equal(draft.components[0].content, "Welcome {user} to [server]");

  const botInterpolation = createRequire(import.meta.url)("../../src/onboarding/interpolate") as {
    interpolate: (value: string, values: Record<string, unknown>) => string;
  };
  const values = {
    username: "nova", userTag: "nova", userId: "123456789012345678",
    guildName: "Nila Support Server", channelName: "welcome", memberCount: 128,
    mentionEnabled: false, inviterId: null, inviterName: null,
  };
  const senderTokens = "{user} {user.mention} {guild} {server} {memberCount} [userName] [user.tag] [user.id] [server] [guild] [channel] [memberCount] [inviter] [inviterName]";
  assert.equal(previewOnboardingText(senderTokens), botInterpolation.interpolate(senderTokens, values));
});

test("goodbye editor renders offline with raid-silence honesty", async () => {
  (globalThis as Record<string, unknown>).React = ReactNamespace;
  const { GoodbyeContent } = await import("../src/components/dashboard/GoodbyeContent");
  const html = renderToStaticMarkup(
    createElement(GoodbyeContent, {
      guildId: GUILD_ID,
      document: null,
      channels: [{ id: CHANNEL_ID, name: "farewells" }],
    }),
  );
  assert.match(html, /nothing is posted when members leave/i);
  assert.match(html, /Save goodbye settings/);
  assert.match(html, /Send test/);
  assert.match(html, /silenced/);
  assert.match(html, /Message \(0\/2000\)/);
  assert.match(html, /nova has left Nila Support Server/);
  assert.match(readSource("src/components/dashboard/GoodbyeContent.tsx"), /disabled=\{saving \|\| !dirty\}/);
  const directoryOffline = renderToStaticMarkup(createElement(GoodbyeContent, {
    guildId: GUILD_ID,
    document: null,
    channels: [],
    channelsAvailable: false,
  }));
  assert.match(directoryOffline, /live channel directory is unavailable/i);
  assert.match(directoryOffline, /disabled=""/);
});


test("ProBot-style delivery preserves website/bot parity for DM-only, modes and card geometry", () => {
  const bot = createRequire(import.meta.url)("../../src/onboarding/validation");
  const config = fullConfig();
  const welcome = config.welcome as Record<string, unknown>;
  Object.assign(welcome, {enabled:true, delivery:{textEnabled:true,template:"Hi [user]",destination:"dm",imageMode:"with_text",imageChannelId:null}});
  assert.ok(validateOnboarding(config).values);
  assert.equal(bot.validateOnboardingValues(config).ok,true);
  for (const imageMode of ["with_text","before_text","channel_only"]) {
    welcome.delivery = {textEnabled:true,template:"Hi [user]",destination:"dm",imageMode,imageChannelId:CHANNEL_ID};
    welcome.card = {transparent:true,size:{width:1920,height:1080},avatar:{shape:"square",x:20,y:20,width:100,height:100},lines:[{text:"[userName]",color:"#ffffff",weight:"bold",fontSize:24,maxWidth:400,align:"left"}]};
    assert.ok(validateOnboarding(config).values,imageMode);
    assert.equal(bot.validateOnboardingValues(config).ok,true,imageMode);
  }
  (welcome.card as Record<string,unknown>).transparent = "yes";
  assert.equal(validateOnboarding(config).values,null);
  assert.equal(bot.validateOnboardingValues(config).ok,false);
});
