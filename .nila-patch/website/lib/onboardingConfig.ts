import { deliveryError, roleSelectError } from "../../../../shared/welcomeContract";
/**
 * Onboarding configuration (Welcome system P2) — website-side model,
 * validation, reads, and the revision-guarded save flow.
 *
 * One narrow flow, mirroring the ticket-settings conventions:
 *
 * - persisted in its own `guild_onboarding` collection (one document per
 *   guild) so a welcome save can never collide with the ticket-config
 *   document's revision counter or whole-document CAS writes;
 * - the PATCH body is allowlisted exactly: `welcome`, `goodbye`,
 *   `autoRoles`, `joinLogChannelId`, plus a mandatory integer
 *   `expectedRevision` (0 = first save, creating the document);
 * - every save is one atomic whole-document compare-and-set; a stale
 *   revision fails with 409 and changes nothing;
 * - reads never provision: a missing document is reported as
 *   not-configured;
 * - everything is disabled by default and an enabled block is only valid
 *   with its required fields present — a saved config can never silently
 *   send anything the manager did not configure.
 *
 * Welcome/goodbye messages are real Components V2 designs authored with the
 * Component V2 Studio model (`component-v2.ts`), constrained further for
 * join messages: simple blocks only, with at most one wrapping container
 * (the editor unwraps it so blocks stay editable), Link buttons only
 * (welcome messages must not depend on interaction handlers), and the only
 * permitted `attachment://` references are the welcome card
 * (`attachment://welcome-card.png`) and the joining member's avatar
 * (`attachment://member-avatar.png`), both uploaded by the bot at send time.
 * The bot-side validator (P3) mirrors these bounds; parity is test-locked
 * the same way panel payload parity already is.
 */
import {
  findAuthorizedGuild,
  isTrustedOrigin,
  sessionFailureReason,
  type DiscordGuild,
  type WebsiteSessionData,
} from "../auth/core";
import { resolveSnapshotAccess } from "./access";
import { classifyDatabaseError, getOnboardingStore } from "./database";
import {
  createSnapshotRequestId,
  logSnapshotFailure,
  type SnapshotFailureSink,
} from "./diagnostics";
import { designFromUnknown, validateDesign } from "../component-v2";
import type { StudioDesign, V2Node } from "../component-v2";
import { validateCard as validateCardShape } from "nila-card";

const GUILD_ID_PATTERN = /^\d{17,20}$/;

export const CARD_ATTACHMENT_URL = "attachment://welcome-card.png";
// The joining member's own avatar, attached by the bot at send time; the
// second and last permitted attachment reference in a welcome design.
export const AVATAR_ATTACHMENT_URL = "attachment://member-avatar.png";
export const CARD_PRESETS = ["river-1", "river-2", "dusk-1", "aurora-1"] as const;
/** Join messages stay lean: a tighter budget than Discord's message cap. */
export const WELCOME_MAX_COMPONENTS = 40;
export const WELCOME_AUTOROLE_MAX = 10;
export const WELCOME_CARD_MAX_LINES = 4;

export type WelcomeDesignInput = {
  delivery?: { textEnabled: boolean; template: string; destination: "channel" | "dm"; imageMode: "with_text" | "before_text" | "channel_only"; imageChannelId: string | null };
  roleSelect?: { enabled: boolean; prompt: string; roleIds: string[] };
  enabled: boolean;
  channelId: string | null;
  mode: "channel" | "channel+dm";
  mention: boolean;
  cardEnabled: boolean;
  design: Record<string, unknown> | null;
  card: Record<string, unknown> | null;
};

export type GoodbyeInput = {
  template?: string;
  enabled: boolean;
  channelId: string | null;
  design: Record<string, unknown> | null;
};

export type AutoRolesInput = {
  enabled: boolean;
  roleIds: string[];
  skipBots: boolean;
};

export type OnboardingValues = {
  welcome: WelcomeDesignInput;
  goodbye: GoodbyeInput;
  autoRoles: AutoRolesInput;
  joinLogChannelId: string | null;
};

export type OnboardingDocument = OnboardingValues & {
  guildId: string;
  revision: number;
  updatedAt: string;
};

export type OnboardingStore = {
  get(guildId: string): Promise<OnboardingDocument | null>;
  /** Optional: recent-joins delivery history (W5 observability read). */
  getRecentJoins?(guildId: string): Promise<JoinRecord[]>;
  /** Optional on the interface: only the upload flow needs it. */
  saveUpload?(args: {
    guildId: string;
    uploadId: string;
    image: Uint8Array;
    contentType: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Optional: load a stored background for card preview/rendering. */
  getUpload?(args: {
    guildId: string;
    uploadId: string;
  }): Promise<{ image: Uint8Array; contentType: string } | null>;
  saveCas(args: {
    guildId: string;
    values: OnboardingValues;
    expectedRevision: number;
  }): Promise<
    | { ok: true; document: OnboardingDocument }
    | { ok: false; reason: "stale" | "invalid" | "storage-error" }
  >;
};

export type ValidationIssue = { path: string; message: string };

/**
 * One bounded recent-joins delivery record (W5), as written by the bot's
 * sanitized `recordJoin`. Newest last; the dashboard renders it newest first.
 */
export type JoinRecord = {
  memberId: string | null;
  username: string;
  action: string;
  reason: string;
  deliveredTo: string;
  notes: string[];
  cardWarnings: string[];
  recordedAt: string;
};

export type OnboardingOutcome =
  | { status: 200; body: { onboarding: OnboardingDocument } }
  | { status: 400; body: { error: "invalid-body" | "invalid-guild-id" | "invalid-config"; issues?: ValidationIssue[] } }
  | { status: 401; body: { error: "auth-required" | "session-expired" } }
  | { status: 403; body: { error: "no-permission" | "invalid-origin" } }
  | { status: 405; body: { error: "method-not-allowed" } }
  // A rejected write carries back the document that won whenever storage can
  // read it, so an editor can adopt the newer revision and retry instead of
  // dead-ending on "someone saved first".
  | { status: 409; body: { error: "stale-revision"; onboarding?: OnboardingDocument } }
  | { status: 429; body: { error: "rate-limited" }; headers: { "Retry-After": string } }
  | { status: 500; body: { error: "internal-error" } }
  | { status: 503; body: { error: "database-unavailable" | "discord-unavailable" | "discord-rate-limited" | "configuration" } };

export type OnboardingReadResult =
  | { ok: true; data: { status: "ok"; document: OnboardingDocument } }
  | { ok: true; data: { status: "not-configured" } }
  | { ok: true; data: { status: "invalid" } }
  | { ok: false; status: 400 | 401 | 403 | 500 | 503; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function snowflakeOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && GUILD_ID_PATTERN.test(value)) return value;
  return undefined; // invalid
}

// ---------------------------------------------------------------------------
// Design validation — Studio model plus welcome-specific limits.
// ---------------------------------------------------------------------------

const WELCOME_TOP_LEVEL_KINDS = ["textDisplay", "section", "mediaGallery", "separator", "actionRow"];
const WELCOME_CONTAINER_MAX_CHILDREN = 10;

function walkNodes(node: V2Node, visit: (entry: V2Node) => void): void {
  visit(node);
  for (const child of node.components ?? []) walkNodes(child, visit);
  if (node.accessory) walkNodes(node.accessory, visit);
}

function mediaUrlAllowed(url: string | undefined): boolean {
  if (!url) return false;
  if (/^https:\/\//i.test(url)) return true;
  return url === CARD_ATTACHMENT_URL || url === AVATAR_ATTACHMENT_URL;
}

/**
 * Validate one message design for welcome/goodbye use. Returns the rebuilt
 * editor-safe design (so stored JSON is always the canonical shape) plus
 * any issues. Discord-level structure comes from `validateDesign`; the
 * welcome overlay allows at most one wrapping container of simple blocks,
 * rejects interactive buttons and select menus, and rejects any attachment
 * reference other than the rendered card or the member avatar.
 */
export function validateWelcomeDesign(
  value: unknown,
  path: string,
): { design: Record<string, unknown> | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (value === null) return { design: null, issues };
  const design = rebuildDesign(value);
  if (design === null) {
    return { design: null, issues: [{ path, message: "The message design is not a recognizable Components V2 design." }] };
  }
  for (const violation of validateDesign(design)) {
    if (violation.severity === "error") {
      issues.push({ path: `${path} → ${violation.path}`, message: violation.message });
    }
  }
  let total = 0;
  // Exactly one top-level container is allowed, and only as a wrapper.
  const containers = design.components.filter((node) => node.kind === "container");
  if (containers.length > 1 || (containers.length === 1 && design.components.length > 1)) {
    issues.push({ path, message: "A welcome container must be the only top-level block." });
  }
  for (const container of containers) {
    const children = container.components ?? [];
    if (children.length === 0 || children.length > WELCOME_CONTAINER_MAX_CHILDREN) {
      issues.push({ path, message: `A welcome container holds 1-${WELCOME_CONTAINER_MAX_CHILDREN} blocks.` });
    }
    if (children.some((child) => child.kind === "container")) {
      issues.push({ path, message: "Containers cannot be nested in welcome messages." });
    }
    if (children.some((child) => !WELCOME_TOP_LEVEL_KINDS.includes(child.kind))) {
      issues.push({ path, message: "Only text, sections, images, dividers, and link buttons may sit inside a welcome container." });
    }
  }
  design.components.forEach((node, index) => {
    if (node.kind !== "container" && !WELCOME_TOP_LEVEL_KINDS.includes(node.kind)) {
      issues.push({
        path: `${path} → block #${index + 1}`,
        message: `Welcome messages use simple blocks; ${node.kind} is not allowed.`,
      });
    }
  });
  for (const node of design.components) {
    walkNodes(node, (entry) => {
      total += 1;
      if (entry.kind === "button" && (entry.style ?? 2) !== 5) {
        issues.push({ path, message: "Welcome buttons must be Link buttons — interaction handlers arrive with bot integration." });
      }
      if (entry.kind === "stringSelect" || entry.kind === "userSelect" || entry.kind === "roleSelect"
        || entry.kind === "mentionableSelect" || entry.kind === "channelSelect") {
        issues.push({ path, message: "Select menus are not allowed in welcome messages." });
      }
      if (entry.kind === "mediaGallery") {
        for (const item of entry.items ?? []) {
          if (!mediaUrlAllowed(item.url)) {
            issues.push({ path, message: `Gallery media "${item.url || "(empty)"}" must be an https URL, the welcome card reference, or the member avatar reference.` });
          }
        }
      }
      if (entry.kind === "thumbnail" && !mediaUrlAllowed(entry.url)) {
        issues.push({ path, message: "Thumbnails must use an https URL, the welcome card reference, or the member avatar reference." });
      }
    });
  }
  if (total > WELCOME_MAX_COMPONENTS) {
    issues.push({ path, message: `A welcome message holds at most ${WELCOME_MAX_COMPONENTS} components.` });
  }
  if (issues.length > 0) return { design: null, issues };
  return { design: JSON.parse(JSON.stringify(design)) as Record<string, unknown>, issues };
}

function rebuildDesign(value: unknown): StudioDesign | null {
  // Stored designs carry the Studio's editor shape (nodes with `kind`);
  // designFromUnknown rebuilds them safely and rejects anything else.
  if (!isRecord(value) || !Array.isArray(value.components)) return null;
  const name = typeof value.name === "string" ? value.name : "design";
  return designFromUnknown(value, name);
}

// ---------------------------------------------------------------------------
// Card validation.
// ---------------------------------------------------------------------------

/**
 * Validate one welcome card. The rules live in `nila-card` (the same package
 * the bot validates against and the renderer draws from), so a card that the
 * dashboard accepts is a card the bot can always render — no drift between
 * the two surfaces is possible. This wrapper keeps the dashboard's
 * `{ card, issues }` shape and returns a canonical copy for storage.
 */
export function validateCard(value: unknown, path: string): { card: Record<string, unknown> | null; issues: ValidationIssue[] } {
  if (value === null || value === undefined) return { card: null, issues: [] };
  if (!isRecord(value)) return { card: null, issues: [{ path, message: "The card settings must be an object or null." }] };
  const issues: ValidationIssue[] = [];
  validateCardShape(value, path, issues);
  if (issues.length > 0) return { card: null, issues };
  return { card: JSON.parse(JSON.stringify(value)) as Record<string, unknown>, issues };
}

// ---------------------------------------------------------------------------
// Whole-document validation.
// ---------------------------------------------------------------------------

export function validateOnboarding(input: unknown): { values: OnboardingValues | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { values: null, issues: [{ path: "", message: "The body must be a JSON object." }] };

  const welcomeRaw = input.welcome;
  const goodbyeRaw = input.goodbye;
  const autoRolesRaw = input.autoRoles;
  const joinLogRaw = input.joinLogChannelId;
  if (!isRecord(welcomeRaw) || !isRecord(goodbyeRaw) || !isRecord(autoRolesRaw)) {
    return { values: null, issues: [{ path: "", message: "welcome, goodbye, and autoRoles objects are all required." }] };
  }

  // welcome
  const enabled = boolOf(welcomeRaw.enabled);
  const mention = boolOf(welcomeRaw.mention);
  const mode = welcomeRaw.mode;
  if (enabled === null) issues.push({ path: "welcome.enabled", message: "Must be true or false." });
  if (mention === null) issues.push({ path: "welcome.mention", message: "Must be true or false." });
  if (mode !== "channel" && mode !== "channel+dm") issues.push({ path: "welcome.mode", message: "Must be channel or channel+dm." });
  const channelId = snowflakeOrNull(welcomeRaw.channelId);
  if (channelId === undefined) issues.push({ path: "welcome.channelId", message: "Must be a server channel id or null." });
  const designResult = validateWelcomeDesign(welcomeRaw.design, "welcome.design");
  issues.push(...designResult.issues);
  const cardEnabled = boolOf(welcomeRaw.cardEnabled);
  if (cardEnabled === null) issues.push({ path: "welcome.cardEnabled", message: "Must be true or false." });
  const deliveryIssue = deliveryError(welcomeRaw.delivery);
  if (deliveryIssue) issues.push({ path: "welcome.delivery", message: deliveryIssue });
  const roleSelectIssue = roleSelectError(welcomeRaw.roleSelect);
  if (roleSelectIssue) issues.push({ path: "welcome.roleSelect", message: roleSelectIssue });
  // Card content is always validated, even while cardEnabled is false: a
  // stored card must never be one toggle away from invalid. The rules
  // themselves come from nila-card, shared with the bot.
  const cardResult = validateCard(welcomeRaw.card ?? null, "welcome.card");
  issues.push(...cardResult.issues);
  // A card that is switched on needs somewhere to land: the bot refuses this
  // shape too, so the dashboard must not store it.
  if (cardEnabled === true && welcomeRaw.card != null && (channelId === null || channelId === undefined)) {
    issues.push({ path: "welcome.channelId", message: "An enabled welcome card needs a channel." });
  }
  // An enabled welcome with no delivery block and no card posts its design to
  // the welcome channel, so it needs that channel and a design: without them
  // the switch would save and silently never send anything (the editor says
  // as much). A DM-only config is exempt because it carries a `delivery`.
  if (enabled === true && welcomeRaw.delivery == null && welcomeRaw.card == null) {
    if (channelId === null || channelId === undefined) {
      issues.push({ path: "welcome.channelId", message: "An enabled welcome message needs a channel." });
    }
    if (designResult.design === null) {
      issues.push({ path: "welcome.design", message: "An enabled welcome message needs a valid message design." });
    }
  }
  if (enabled === true && isRecord(welcomeRaw.delivery)) {
    if (welcomeRaw.delivery.destination === "channel" && (welcomeRaw.delivery.textEnabled || welcomeRaw.delivery.imageMode !== "channel_only") && !channelId) issues.push({ path: "welcome.channelId", message: "Choose a text channel." });
    if (welcomeRaw.delivery.imageMode === "channel_only" && welcomeRaw.card && !welcomeRaw.delivery.imageChannelId) issues.push({ path: "welcome.delivery", message: "Choose an image channel." });
    if (!welcomeRaw.delivery.textEnabled && !welcomeRaw.card) issues.push({ path: "welcome.delivery", message: "Enable text or configure an image." });
  }
  // An enabled DM mode still needs a channel to announce in channel mode combos;
  // the bot re-checks deliverability at send time either way.

  // goodbye
  const goodbyeEnabled = boolOf(goodbyeRaw.enabled);
  const goodbyeChannel = snowflakeOrNull(goodbyeRaw.channelId);
  if (goodbyeEnabled === null) issues.push({ path: "goodbye.enabled", message: "Must be true or false." });
  if (goodbyeChannel === undefined) issues.push({ path: "goodbye.channelId", message: "Must be a server channel id or null." });
  const goodbyeDesign = validateWelcomeDesign(goodbyeRaw.design ?? null, "goodbye.design");
  issues.push(...goodbyeDesign.issues);
  if (goodbyeEnabled === true && (goodbyeChannel === null || goodbyeChannel === undefined)) {
    issues.push({ path: "goodbye.channelId", message: "An enabled goodbye message needs a channel." });
  }
  if (goodbyeEnabled === true && goodbyeDesign.design === null && !goodbyeRaw.template) {
    issues.push({ path: "goodbye.design", message: "An enabled goodbye message needs a valid message design." });
  }

  if (goodbyeRaw.template !== undefined && (typeof goodbyeRaw.template !== "string" || goodbyeRaw.template.length > 2000)) issues.push({ path: "goodbye.template", message: "Template must be at most 2000 characters." });
  // autoRoles
  const rolesEnabled = boolOf(autoRolesRaw.enabled);
  const skipBots = boolOf(autoRolesRaw.skipBots);
  if (rolesEnabled === null) issues.push({ path: "autoRoles.enabled", message: "Must be true or false." });
  if (skipBots === null) issues.push({ path: "autoRoles.skipBots", message: "Must be true or false." });
  let roleIds: string[] = [];
  if (Array.isArray(autoRolesRaw.roleIds)) {
    roleIds = autoRolesRaw.roleIds.filter((entry): entry is string => typeof entry === "string" && GUILD_ID_PATTERN.test(entry));
    if (roleIds.length !== autoRolesRaw.roleIds.length) {
      issues.push({ path: "autoRoles.roleIds", message: "Every auto-role must be a valid role id." });
    }
    if (new Set(roleIds).size !== roleIds.length) {
      issues.push({ path: "autoRoles.roleIds", message: "Auto-role ids must be unique." });
    }
    if (roleIds.length > WELCOME_AUTOROLE_MAX) {
      issues.push({ path: "autoRoles.roleIds", message: `At most ${WELCOME_AUTOROLE_MAX} auto-roles per server.` });
    }
  } else {
    issues.push({ path: "autoRoles.roleIds", message: "Must be a list of role ids." });
  }
  if (rolesEnabled === true && roleIds.length === 0) {
    issues.push({ path: "autoRoles.roleIds", message: "Enabled auto-roles need at least one role." });
  }

  const joinLog = snowflakeOrNull(joinLogRaw);
  if (joinLog === undefined) issues.push({ path: "joinLogChannelId", message: "Must be a server channel id or null." });

  if (issues.length > 0 || enabled === null || mention === null || rolesEnabled === null || skipBots === null
    || goodbyeEnabled === null || channelId === undefined || goodbyeChannel === undefined || joinLog === undefined
    || cardEnabled === null || (mode !== "channel" && mode !== "channel+dm")) {
    return { values: null, issues };
  }

  const rsRaw = isRecord(welcomeRaw.roleSelect) ? welcomeRaw.roleSelect : null;
  const normalizedRoleSelect = welcomeRaw.roleSelect == null ? {} : {
    roleSelect: {
      enabled: rsRaw?.enabled === true,
      prompt: String(rsRaw?.prompt ?? ""),
      roleIds: [...new Set(Array.isArray(rsRaw?.roleIds) ? (rsRaw!.roleIds as unknown[]).filter((id): id is string => typeof id === "string") : [])],
    },
  };

  return {
    values: {
      welcome: {
        enabled,
        channelId: channelId ?? null,
        mode,
        mention,
        cardEnabled,
        design: designResult.design,
        card: welcomeRaw.card as Record<string, unknown> | null,
        ...(welcomeRaw.delivery == null ? {} : { delivery: welcomeRaw.delivery as WelcomeDesignInput["delivery"] }),
        ...normalizedRoleSelect,
      },
      goodbye: { enabled: goodbyeEnabled, channelId: goodbyeChannel ?? null, design: goodbyeDesign.design, ...(goodbyeRaw.template === undefined ? {} : { template: goodbyeRaw.template as string }) },
      autoRoles: { enabled: rolesEnabled, roleIds: [...new Set(roleIds)], skipBots },
      joinLogChannelId: joinLog ?? null,
    },
    issues: [],
  };
}

/** Exact PATCH body shape: the four blocks plus the mandatory revision. */
export function validateOnboardingBody(body: unknown):
  | { ok: true; values: OnboardingValues; expectedRevision: number }
  | { ok: false; issues: ValidationIssue[] } {
  if (!isRecord(body)) return { ok: false, issues: [{ path: "", message: "Body must be a JSON object." }] };
  const keys = Object.keys(body);
  const allowed = ["welcome", "goodbye", "autoRoles", "joinLogChannelId", "expectedRevision"];
  if (!keys.every((key) => allowed.includes(key)) || !keys.includes("expectedRevision")) {
    return { ok: false, issues: [{ path: "", message: "Body carries unexpected or missing keys." }] };
  }
  const expectedRevision = body.expectedRevision;
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return { ok: false, issues: [{ path: "expectedRevision", message: "Must be an integer of 0 or more." }] };
  }
  const { values, issues } = validateOnboarding({
    welcome: body.welcome,
    goodbye: body.goodbye,
    autoRoles: body.autoRoles,
    joinLogChannelId: body.joinLogChannelId,
  });
  if (values === null) return { ok: false, issues };
  return { ok: true, values, expectedRevision: expectedRevision as number };
}

// ---------------------------------------------------------------------------
// Read (never provisions, never writes).
// ---------------------------------------------------------------------------

export async function readOnboarding(args: {
  session: WebsiteSessionData;
  guilds: DiscordGuild[];
  guildId: string;
  store?: OnboardingStore;
  onFailure?: SnapshotFailureSink;
}): Promise<OnboardingReadResult> {
  const access = resolveSnapshotAccess(args.session, args.guilds, args.guildId);
  if (!access.ok) return access;
  const requestId = createSnapshotRequestId();
  const report = (stage: string, error: unknown) => {
    logSnapshotFailure(requestId, stage as "database-init" | "snapshot-build", error, access.guild.id, args.onFailure, "config.onboarding");
  };
  let store = args.store;
  if (!store) {
    try {
      store = await getOnboardingStore();
    } catch (error) {
      report("database-init", error);
      const code = classifyDatabaseError(error);
      return { ok: false, status: code === "internal-error" ? 500 : 503, code };
    }
  }
  if (!store) return { ok: false, status: 503, code: "database-unavailable" };
  try {
    const document = await store.get(access.guild.id);
    if (document === null) return { ok: true, data: { status: "not-configured" } };
    const check = validateOnboarding(document);
    if (check.values === null) return { ok: true, data: { status: "invalid" } };
    return { ok: true, data: { status: "ok", document } };
  } catch (error) {
    // A failed read is an outage, never an "invalid stored config" claim and
    // never an empty default: the honest unavailable outcome instead.
    report("snapshot-build", error);
    return { ok: false, status: 503, code: "database-unavailable" };
  }
}

// ---------------------------------------------------------------------------
// PATCH handler (route-independent, injected store + limiter, like settings).
// ---------------------------------------------------------------------------

export async function handleOnboarding(input: {
  method: string;
  contentType: string | null;
  guildId: string;
  origin: string | null;
  siteUrl: string;
  bodyText: string;
  session: WebsiteSessionData;
  guilds: DiscordGuild[];
  isRateLimited: (key: string) => boolean;
  store: OnboardingStore;
}): Promise<OnboardingOutcome> {
  if (input.method !== "PATCH") return { status: 405, body: { error: "method-not-allowed" } };
  if (!(input.contentType ?? "").includes("application/json")) {
    return { status: 400, body: { error: "invalid-body" } };
  }
  if (!GUILD_ID_PATTERN.test(input.guildId)) return { status: 400, body: { error: "invalid-guild-id" } };

  const failure = sessionFailureReason(input.session);
  if (failure) return { status: 401, body: { error: failure } };
  const userId = input.session.user?.id;
  if (typeof userId !== "string" || !GUILD_ID_PATTERN.test(userId)) {
    return { status: 401, body: { error: "auth-required" } };
  }
  const guild = findAuthorizedGuild(input.guilds, input.guildId);
  if (!guild) return { status: 403, body: { error: "no-permission" } };
  if (!isTrustedOrigin(input.origin, input.siteUrl)) return { status: 403, body: { error: "invalid-origin" } };
  if (input.isRateLimited(`${userId}:${input.guildId}`)) {
    return { status: 429, body: { error: "rate-limited" }, headers: { "Retry-After": "60" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return { status: 400, body: { error: "invalid-body" } };
  }
  const valid = validateOnboardingBody(parsed);
  if (!valid.ok) return { status: 400, body: { error: "invalid-config", issues: valid.issues } };

  const result = await input.store.saveCas({
    guildId: guild.id,
    values: valid.values,
    expectedRevision: valid.expectedRevision,
  });
  if (!result.ok) {
    if (result.reason === "stale") {
      // The caller has already passed every authorization gate above, so
      // handing back their own guild's current document is not a leak: it is
      // what lets an editor adopt the newer revision and retry instead of
      // sitting on a dead-end "someone saved first" message. A failed read
      // simply omits it and the 409 still stands.
      const current = await input.store.get(guild.id).catch(() => null);
      return {
        status: 409,
        body: { error: "stale-revision", ...(current ? { onboarding: current } : {}) },
      };
    }
    if (result.reason === "invalid") {
      return { status: 400, body: { error: "invalid-config", issues: [{ path: "", message: "The bot validator refused this configuration; nothing changed." }] } };
    }
    return { status: 503, body: { error: "database-unavailable" } };
  }
  return { status: 200, body: { onboarding: result.document } };
}

// ---------------------------------------------------------------------------
// Welcome-card background upload (P4). A separate POST flow: base64 image,
// exact-type allowlist, per-type byte cap, opaque server-generated id. The
// stored bytes are only ever read back by the bot's card renderer at join
// time.
//
// An animated GIF background is accepted too: it keeps its animation (the bot
// composites each frame), so it gets the same 10 MB ceiling the bot's upload
// policy uses — Discord's own attachment limit on an unboosted guild.
// Everything else stays at 3 MB.
//
// A background may also arrive as a link (`{ url }`). That is an input method,
// not a storage mode: the bytes are downloaded once, checked by this same
// policy, and stored. Nothing at join time depends on the remote host, so a
// Discord CDN URL that expires after a day cannot break a configured card.
// ---------------------------------------------------------------------------

export const ONBOARDING_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif"];
export const ONBOARDING_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const ONBOARDING_UPLOAD_MAX_GIF_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_FOR = (bytes: number) => Math.ceil((bytes * 4) / 3) + 8;
export const ONBOARDING_UPLOAD_MAX_BASE64 = MAX_BASE64_FOR(ONBOARDING_UPLOAD_MAX_BYTES);
export const ONBOARDING_UPLOAD_MAX_GIF_BASE64 = MAX_BASE64_FOR(ONBOARDING_UPLOAD_MAX_GIF_BYTES);

/** The byte ceiling that applies to one content type. */
export function onboardingUploadBudget(contentType: string): number {
  return contentType === "image/gif" ? ONBOARDING_UPLOAD_MAX_GIF_BYTES : ONBOARDING_UPLOAD_MAX_BYTES;
}

export type OnboardingUploadOutcome =
  | { status: 200; body: { uploadId: string; bytes: number; contentType: string } }
  | { status: 200; body: { chunk: { id: string; received: number; total: number } } }
  | { status: 400; body: { error: "invalid-body" | "invalid-guild-id" | "invalid-upload" | "invalid-chunk" | "source-unavailable"; code?: string } }
  | { status: 401; body: { error: "auth-required" | "session-expired" } }
  | { status: 403; body: { error: "no-permission" | "invalid-origin" } }
  | { status: 405; body: { error: "method-not-allowed" } }
  | { status: 409; body: { error: "chunk-session-missing" } }
  | { status: 413; body: { error: "payload-too-large" } }
  | { status: 429; body: { error: "rate-limited" }; headers: { "Retry-After": string } }
  | { status: 500; body: { error: "internal-error" } }
  | { status: 503; body: { error: "database-unavailable" | "discord-unavailable" | "discord-rate-limited" | "configuration" } };

/** A GIF header is enough here; the bot's policy decodes and counts frames. */
function hasGifSignature(image: Uint8Array): boolean {
  if (image.byteLength < 13) return false;
  const header = Buffer.from(image.subarray(0, 6)).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

/** Accepts exactly `{ dataBase64, contentType }` with a real image inside. */
export function decodeOnboardingUpload(body: unknown):
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false } {
  if (!isRecord(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("dataBase64") || !keys.includes("contentType")) return { ok: false };
  if (typeof body.contentType !== "string" || !ONBOARDING_UPLOAD_TYPES.includes(body.contentType)) return { ok: false };
  const contentType: string = body.contentType;
  const budget = onboardingUploadBudget(contentType);
  const maxBase64 = contentType === "image/gif" ? ONBOARDING_UPLOAD_MAX_GIF_BASE64 : ONBOARDING_UPLOAD_MAX_BASE64;
  if (typeof body.dataBase64 !== "string" || body.dataBase64.length === 0 || body.dataBase64.length > maxBase64) {
    return { ok: false };
  }
  const image = Uint8Array.from(Buffer.from(body.dataBase64, "base64"));
  // Strict round-trip: rejects strings base64 would silently truncate.
  if (image.byteLength === 0 || image.byteLength >= budget) return { ok: false };
  if (Buffer.from(image).toString("base64") !== body.dataBase64) return { ok: false };
  // Cheap structural check so a mislabelled file never reaches storage: the bot
  // re-validates (and re-encodes the still formats) on save.
  if (contentType === "image/gif" && !hasGifSignature(image)) return { ok: false };
  return { ok: true, image, contentType };
}

// ---------------------------------------------------------------------------
// Background by link. Any public https image host is accepted — people paste
// from Gifyu, Catbox, Imgur, their own CDN — but the deployment's own network
// is off limits. The name is resolved first and every address is checked, so a
// DNS name cannot stand in for a private address; redirects are refused, so a
// permitted host cannot bounce the fetch somewhere else.
// ---------------------------------------------------------------------------
const UPLOAD_URL_MAX_LENGTH = 2048;
// A 6-10 MB GIF from a free image host can take ten seconds or more to arrive.
const UPLOAD_URL_TIMEOUT_MS = 25_000;
const BLOCKED_UPLOAD_HOSTS = ["localhost", "metadata", "metadata.google.internal", "instance-data"];
const BLOCKED_UPLOAD_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".corp"];

export type HostResolver = (hostname: string) => Promise<Array<{ address: string } | string>>;

export type OnboardingUploadSource =
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false; reason: "invalid" | "unavailable" };

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? octets : null;
}

/**
 * Loopback, RFC1918, CGNAT, link-local, multicast, reserved, and the IPv6
 * equivalents (including IPv4-mapped forms).
 */
export function isPrivateAddress(address: string): boolean {
  const value = String(address ?? "").toLowerCase();
  if (value === "") return true;
  if (value.includes(":")) {
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    if (value === "::" || value === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // link-local fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(value)) return true; // multicast ff00::/8
    return false;
  }
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_UPLOAD_HOSTS.includes(host) || BLOCKED_UPLOAD_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Magic numbers only; the bot re-validates (and re-encodes) on save. */
function sniffImageType(image: Uint8Array): string | null {
  if (image.byteLength >= 4 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) return "image/png";
  if (image.byteLength >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return "image/jpeg";
  if (hasGifSignature(image)) return "image/gif";
  return null;
}

/** Accepts exactly `{ url }`: https only, public host, no credentials or port. */
export function parseUploadSourceUrl(body: unknown): { ok: true; url: string; host: string } | { ok: false } {
  if (!isRecord(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "url") return { ok: false };
  if (typeof body.url !== "string" || body.url.length === 0 || body.url.length > UPLOAD_URL_MAX_LENGTH) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return { ok: false };
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || isBlockedUploadHost(host) || isPrivateAddress(host)) return { ok: false };
  return { ok: true, url: parsed.toString(), host };
}

/** Download one linked image, bounded by the same per-type budget. */
export async function importOnboardingUpload(
  body: unknown,
  fetchImpl: typeof fetch = fetch,
  resolveHost?: HostResolver,
): Promise<OnboardingUploadSource> {
  const source = parseUploadSourceUrl(body);
  if (!source.ok) return { ok: false, reason: "invalid" };
  // Without a resolver there is no address check, and no download either.
  if (!resolveHost) return { ok: false, reason: "unavailable" };
  let addresses: Array<{ address: string } | string>;
  try {
    const resolved = await resolveHost(source.host);
    addresses = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (addresses.length === 0) return { ok: false, reason: "unavailable" };
  if (addresses.some((entry) => isPrivateAddress(typeof entry === "string" ? entry : entry?.address ?? ""))) {
    return { ok: false, reason: "invalid" };
  }
  let response: Response;
  try {
    response = await fetchImpl(source.url, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(UPLOAD_URL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "unavailable" };
  const header = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const declaredType = ONBOARDING_UPLOAD_TYPES.includes(header) ? header : null;
  // The type is unknown until the bytes arrive, so read against the widest budget.
  const budget = onboardingUploadBudget(declaredType ?? "image/gif");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared >= budget) return { ok: false, reason: "invalid" };
  let image: Uint8Array;
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total >= budget) {
          await reader.cancel();
          return { ok: false, reason: "invalid" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    image = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      image.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    try {
      image = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  if (image.byteLength === 0) return { ok: false, reason: "invalid" };
  // Bytes decide the type: some hosts serve images as octet-stream, and a page
  // served as image/gif is caught here rather than in storage.
  const contentType = sniffImageType(image) ?? declaredType;
  if (!contentType) return { ok: false, reason: "invalid" };
  if (image.byteLength >= onboardingUploadBudget(contentType)) return { ok: false, reason: "invalid" };
  return { ok: true, image, contentType };
}

// ---------------------------------------------------------------------------
// Chunked upload. A reverse proxy with a 1 MB body limit (nginx's default)
// refuses a multi-megabyte GIF long before the route sees it, so the designer
// sends big files as slices. Assembly happens in memory, keyed to the owner and
// guild, and nothing is written to storage until the last slice arrives. The
// assembled bytes then go through exactly the same policy as a single request.
// ---------------------------------------------------------------------------
/** Raw bytes per slice; the base64 wrapper is ~683 KB, under a 1 MB proxy cap. */
export const ONBOARDING_CHUNK_BYTES = 512 * 1024;
const ONBOARDING_CHUNK_MAX_CHARS = Math.ceil((ONBOARDING_CHUNK_BYTES * 4) / 3) + 8;
const ONBOARDING_CHUNK_COUNT_MAX = 40;
const ONBOARDING_CHUNK_TTL_MS = 5 * 60_000;
const ONBOARDING_CHUNK_SESSIONS_MAX = 8;

type ChunkSession = {
  guildId: string;
  userId: string;
  contentType: string;
  total: number;
  parts: Uint8Array[];
  bytes: number;
  expiresAt: number;
};

const chunkSessions = new Map<string, ChunkSession>();

/** Test hook: drop every half-finished upload. */
export function resetOnboardingChunkSessions(): void {
  chunkSessions.clear();
}

function pruneChunkSessions(now: number): void {
  for (const [id, session] of chunkSessions) {
    if (session.expiresAt <= now) chunkSessions.delete(id);
  }
}

function newChunkSessionId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/**
 * One slice of a large upload. Slices must arrive in order; the reply carries
 * the session id the client echoes back, and the last slice returns the stored
 * upload id like a single-shot request would.
 */
export async function handleOnboardingChunk(input: {
  guildId: string;
  userId: string;
  chunk: unknown;
  store: OnboardingStore;
  newUploadId: () => string;
}): Promise<OnboardingUploadOutcome> {
  const chunk = input.chunk;
  if (!isRecord(chunk)) return { status: 400, body: { error: "invalid-chunk" } };
  const { id, index, total, dataBase64, contentType } = chunk;
  if (typeof contentType !== "string" || !ONBOARDING_UPLOAD_TYPES.includes(contentType)) {
    return { status: 400, body: { error: "invalid-chunk" } };
  }
  if (!Number.isInteger(index) || !Number.isInteger(total)) return { status: 400, body: { error: "invalid-chunk" } };
  const sliceIndex = index as number;
  const sliceTotal = total as number;
  if (sliceTotal < 1 || sliceTotal > ONBOARDING_CHUNK_COUNT_MAX) return { status: 400, body: { error: "invalid-chunk" } };
  if (sliceIndex < 0 || sliceIndex >= sliceTotal) return { status: 400, body: { error: "invalid-chunk" } };
  if (typeof dataBase64 !== "string" || dataBase64.length === 0 || dataBase64.length > ONBOARDING_CHUNK_MAX_CHARS) {
    return { status: 400, body: { error: "invalid-chunk" } };
  }
  const bytes = Uint8Array.from(Buffer.from(dataBase64, "base64"));
  // Round-trip keeps a truncated slice from being stored as a shorter file.
  if (bytes.byteLength === 0 || bytes.byteLength > ONBOARDING_CHUNK_BYTES) {
    return { status: 400, body: { error: "invalid-chunk" } };
  }
  if (Buffer.from(bytes).toString("base64") !== dataBase64) return { status: 400, body: { error: "invalid-chunk" } };

  const now = Date.now();
  pruneChunkSessions(now);
  const offeredId = typeof id === "string" ? id : "";
  const existing = offeredId ? chunkSessions.get(offeredId) : undefined;
  let sessionIdInUse = offeredId;
  let session: ChunkSession;
  if (!existing) {
    if (sliceIndex !== 0) return { status: 409, body: { error: "chunk-session-missing" } };
    if (chunkSessions.size >= ONBOARDING_CHUNK_SESSIONS_MAX) {
      const oldest = chunkSessions.keys().next().value;
      if (oldest) chunkSessions.delete(oldest);
    }
    session = {
      guildId: input.guildId,
      userId: input.userId,
      contentType,
      total: sliceTotal,
      parts: [],
      bytes: 0,
      expiresAt: now + ONBOARDING_CHUNK_TTL_MS,
    };
    sessionIdInUse = newChunkSessionId();
    chunkSessions.set(sessionIdInUse, session);
  } else {
    session = existing;
    if (session.guildId !== input.guildId || session.userId !== input.userId) {
      return { status: 400, body: { error: "invalid-chunk" } };
    }
    if (session.contentType !== contentType || session.total !== sliceTotal || sliceIndex !== session.parts.length) {
      return { status: 400, body: { error: "invalid-chunk" } };
    }
  }
  const budget = onboardingUploadBudget(contentType);
  if (session.bytes + bytes.byteLength >= budget) {
    chunkSessions.delete(sessionIdInUse);
    return { status: 413, body: { error: "payload-too-large" } };
  }
  session.parts.push(bytes);
  session.bytes += bytes.byteLength;
  session.expiresAt = now + ONBOARDING_CHUNK_TTL_MS;

  if (sliceIndex + 1 < sliceTotal) {
    return { status: 200, body: { chunk: { id: sessionIdInUse, received: session.parts.length, total: sliceTotal } } };
  }

  chunkSessions.delete(sessionIdInUse);
  const image = new Uint8Array(session.bytes);
  let offset = 0;
  for (const part of session.parts) {
    image.set(part, offset);
    offset += part.byteLength;
  }
  if (image.byteLength === 0 || image.byteLength >= budget) return { status: 400, body: { error: "invalid-upload" } };
  if (contentType === "image/gif" && !hasGifSignature(image)) return { status: 400, body: { error: "invalid-upload" } };
  const uploadId = input.newUploadId();
  if (!/^[0-9a-f]{8,64}$/.test(uploadId) || !input.store.saveUpload) {
    return { status: 500, body: { error: "internal-error" } };
  }
  const result = await input.store.saveUpload({ guildId: input.guildId, uploadId, image, contentType });
  if (!result.ok) {
    if (result.code === "REPOSITORY_UNAVAILABLE" || result.code === "DATABASE_UNAVAILABLE") {
      return { status: 503, body: { error: "database-unavailable" } };
    }
    return { status: 400, body: { error: "invalid-upload", code: String(result.code ?? "") } };
  }
  return { status: 200, body: { uploadId, bytes: image.byteLength, contentType } };
}

export async function handleOnboardingUpload(input: {
  method: string;
  contentType: string | null;
  guildId: string;
  origin: string | null;
  siteUrl: string;
  bodyText: string;
  session: WebsiteSessionData;
  guilds: DiscordGuild[];
  isRateLimited: (key: string) => boolean;
  store: OnboardingStore;
  newUploadId: () => string;
  /** Injectable for tests; defaults to one bounded real download. */
  importUpload?: (body: unknown) => Promise<OnboardingUploadSource>;
  /** Resolves linked host names so a private address cannot be reached. */
  resolveHost?: HostResolver;
}): Promise<OnboardingUploadOutcome> {
  if (input.method !== "POST") return { status: 405, body: { error: "method-not-allowed" } };
  if (!(input.contentType ?? "").includes("application/json")) {
    return { status: 400, body: { error: "invalid-body" } };
  }
  if (!GUILD_ID_PATTERN.test(input.guildId)) return { status: 400, body: { error: "invalid-guild-id" } };
  const failure = sessionFailureReason(input.session);
  if (failure) return { status: 401, body: { error: failure } };
  const userId = input.session.user?.id;
  if (typeof userId !== "string" || !GUILD_ID_PATTERN.test(userId)) {
    return { status: 401, body: { error: "auth-required" } };
  }
  const guild = findAuthorizedGuild(input.guilds, input.guildId);
  if (!guild) return { status: 403, body: { error: "no-permission" } };
  if (!isTrustedOrigin(input.origin, input.siteUrl)) return { status: 403, body: { error: "invalid-origin" } };
  if (input.isRateLimited(`${userId}:${input.guildId}`)) {
    return { status: 429, body: { error: "rate-limited" }, headers: { "Retry-After": "60" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return { status: 400, body: { error: "invalid-body" } };
  }
  // A file too big for the reverse proxy arrives as numbered slices instead of
  // one body; the gates above already ran, so only assembly is left.
  if (isRecord(parsed) && Object.keys(parsed).length === 1 && "chunk" in parsed) {
    return handleOnboardingChunk({
      guildId: guild.id,
      userId,
      chunk: parsed.chunk,
      store: input.store,
      newUploadId: input.newUploadId,
    });
  }
  // Either `{ dataBase64, contentType }` (a file) or `{ url }` (a link). Both
  // end up as the same validated bytes, so everything downstream is identical.
  let source: OnboardingUploadSource;
  const decoded = decodeOnboardingUpload(parsed);
  if (decoded.ok) source = decoded;
  else source = await (input.importUpload ?? ((body: unknown) => importOnboardingUpload(body, fetch, input.resolveHost)))(parsed);
  if (!source.ok) {
    return source.reason === "unavailable"
      ? { status: 400, body: { error: "source-unavailable" } }
      : { status: 400, body: { error: "invalid-upload" } };
  }
  const uploadId = input.newUploadId();
  if (!/^[0-9a-f]{8,64}$/.test(uploadId) || !input.store.saveUpload) {
    return { status: 500, body: { error: "internal-error" } };
  }
  const result = await input.store.saveUpload({
    guildId: guild.id,
    uploadId,
    image: source.image,
    contentType: source.contentType,
  });
  if (!result.ok) {
    if (result.code === "REPOSITORY_UNAVAILABLE" || result.code === "DATABASE_UNAVAILABLE") {
      return { status: 503, body: { error: "database-unavailable" } };
    }
    return { status: 400, body: { error: "invalid-upload", code: String(result.code ?? "") } };
  }
  return { status: 200, body: { uploadId, bytes: source.image.byteLength, contentType: source.contentType } };
}
