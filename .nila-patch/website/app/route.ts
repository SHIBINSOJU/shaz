import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthConfigurationError } from "@/lib/auth/core";
import {
  DiscordApiError,
  getDiscordGuildsCached,
  getWebsiteConfig,
  getWebsiteSession,
} from "@/lib/auth/server";
import { classifyDatabaseError, getOnboardingStore } from "@/lib/config/database";
import { handleOnboardingUpload, ONBOARDING_UPLOAD_MAX_GIF_BASE64 } from "@/lib/config/onboardingConfig";
import { onboardingUploadRateLimiter } from "@/lib/config/rateLimit";

/**
 * POST /api/config/[guildId]/onboarding/upload (Welcome system P4).
 *
 * Stores one welcome-card background image (PNG/JPEG under 3 MiB, animated GIF
 * under 10 MiB) as an opaque upload id through the bot's policy-checked
 * onboarding service. The body is `{ dataBase64, contentType }` for a file or
 * `{ url }` for a link, which is downloaded once, here — the id is generated
 * server-side, never taken from the client. Bytes are only ever read back by
 * the bot's card renderer when a welcome is sent — nothing here serves or
 * publishes them.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ guildId: string }> };

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { guildId } = await params;

  let session;
  try {
    session = await getWebsiteSession();
  } catch (error) {
    if (error instanceof AuthConfigurationError) return jsonError("configuration", 503);
    return jsonError("internal-error", 500);
  }
  const accessToken = session.accessToken;
  if (!accessToken) return jsonError("auth-required", 401);

  let guilds;
  try {
    guilds = await getDiscordGuildsCached(accessToken);
  } catch (error) {
    if (error instanceof DiscordApiError && error.code === "unauthorized") {
      return jsonError("session-expired", 401);
    }
    if (error instanceof DiscordApiError && error.code === "rate-limited") {
      return jsonError("discord-rate-limited", 503);
    }
    return jsonError("discord-unavailable", 503);
  }

  let siteUrl: string;
  try {
    siteUrl = getWebsiteConfig().siteUrl;
  } catch {
    return jsonError("configuration", 503);
  }

  // A body this large cannot be stored anyway; answer with JSON instead of
  // buffering it first. Big files normally arrive as slices, which are small.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ONBOARDING_UPLOAD_MAX_GIF_BASE64 + 4096) {
    return jsonError("payload-too-large", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonError("invalid-body", 400);
  }

  let store;
  try {
    store = await getOnboardingStore();
  } catch (error) {
    const code = classifyDatabaseError(error);
    return jsonError(code, code === "internal-error" ? 500 : 503);
  }

  const result = await handleOnboardingUpload({
    method: request.method,
    contentType: request.headers.get("content-type"),
    guildId,
    origin: request.headers.get("origin"),
    siteUrl,
    bodyText,
    session,
    guilds,
    isRateLimited: (key) => !onboardingUploadRateLimiter.check(key),
    store,
    newUploadId: () => randomUUID().replaceAll("-", ""),
    // A linked background is fetched only after every resolved address is
    // confirmed public; the allowlist-free policy lives in onboardingConfig.
    resolveHost: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  });

  if ("headers" in result && result.headers) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { ...result.headers, "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
