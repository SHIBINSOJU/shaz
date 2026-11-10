"use client";

/**
 * Welcome card designer (Welcome system P4).
 *
 * Uses the bot's canvas renderer for the editor surface and Discord-message
 * preview. The rendered PNG is the single visual source of truth; only its
 * avatar hit target is interactive for drag and keyboard positioning.
 *
 * Backgrounds: bundled procedural presets (approximated with CSS), or a
 * member-uploaded image sent to the card upload route (<3 MiB, exact image
 * types) and stored server-side by opaque id.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Link2, Move, Trash2 } from "lucide-react";
import { createSampleCardValues } from "nila-card/sampleValues";
import { inputClass } from "./console-ui";

export type CardConfig = {
  transparent?: boolean;
  backgroundFit?: "cover" | "contain" | "stretch";
  preset: string | null;
  uploadId: string | null;
  size: { width: number; height: number };
  avatar: { x?: number; y?: number; width?: number; height?: number; xPct: number; yPct: number; sizePct: number; shape: string; ringColor: string | null };
  lines: { x?: number; y?: number; fontSize?: number; maxWidth?: number; align?: "left" | "center" | "right"; letterSpacing?: number; text: string; xPct: number; yPct: number; sizePct: number; color: string; weight: string }[];
  backgroundDim: number;
};

export const DEFAULT_CARD: CardConfig = {
  preset: "river-1",
  uploadId: null,
  size: { width: 1024, height: 360 },
  avatar: { xPct: 18, yPct: 50, sizePct: 55, shape: "circle", ringColor: "#22d3ee" },
  lines: [
    { text: "Welcome {user} to {guild}!", xPct: 62, yPct: 38, sizePct: 9, color: "#f1f6ff", weight: "bold" },
    { text: "member #{memberCount} · say hello 👋", xPct: 62, yPct: 62, sizePct: 5, color: "#c9d9f7", weight: "regular" },
  ],
  backgroundDim: 15,
};

function normalizeCard(card: CardConfig | null): CardConfig {
  return {...DEFAULT_CARD,...card,size:{...DEFAULT_CARD.size,...card?.size},avatar:{...DEFAULT_CARD.avatar,...card?.avatar},lines:(card?.lines??DEFAULT_CARD.lines).map(line=>({...DEFAULT_CARD.lines[0],...line}))};
}
function avatarGeometry(card: CardConfig) {
  const a=card.avatar, w=card.size.width,h=card.size.height;
  const size=a.sizePct/100*h;
  const pixel=[a.x,a.y,a.width,a.height].some(value=>value!==undefined);
  return {left:`${pixel?(a.x??a.xPct/100*w-size/2)/w*100:a.xPct}%`,top:`${pixel?(a.y??a.yPct/100*h-size/2)/h*100:a.yPct}%`,width:`${(a.width??size)/w*100}%`,height:`${(a.height??size)/h*100}%`,transform:pixel?'none':'translate(-50%, -50%)'};
}

const PRESET_SWATCHES: Record<string, string> = {
  "river-1": "linear-gradient(180deg, #071026 0%, #132a68 100%)",
  "river-2": "linear-gradient(135deg, #030714 0%, #1d4ed8 100%)",
  "dusk-1": "linear-gradient(180deg, #2a1a3a 0%, #5b2a54 55%, #12203f 100%)",
  "aurora-1": "linear-gradient(90deg, #04211f 0%, #131a44 100%)",
};

const PRESET_TITLES: Record<string, string> = {
  "river-1": "Nila river (deep)",
  "river-2": "Nila river (dusk)",
  "dusk-1": "Dusk wave",
  "aurora-1": "Aurora field",
};

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
// An animated GIF keeps its animation on the posted card, so it is allowed the
// bigger budget the bot's upload policy uses (Discord's 10 MB ceiling).
const MAX_UPLOAD_GIF_BYTES = 10 * 1024 * 1024;

export type ExactCardPreviewState = {
  previewUrl: string | null;
  state: "idle" | "loading" | "ready" | "unavailable";
};

/** One shared, server-rendered PNG feeds both the editor and Discord message preview. */
export function CardMock({ card, preview }: { card: CardConfig; preview: ExactCardPreviewState }) {
  return <ExactCardPreview card={card} {...preview} />;
}

export function useExactCardPreview(card: CardConfig, guildName: string, guildId: string, enabled = true, channelName: string | null = null): ExactCardPreviewState {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [state, setState] = useState<ExactCardPreviewState["state"]>(enabled ? "loading" : "idle");
  const previewUrlRef = useRef<string | null>(null);
  const cardJson = JSON.stringify(normalizeCard(card));

  useEffect(() => {
    if (!enabled) {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      setPreviewUrl(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState("loading");

    // Debounce edits so continuous slider/text changes don't spend the
    // preview endpoint's per-user rate limit. Keep the previous exact render
    // visible and refresh it quietly as soon as the user pauses.
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/config/${guildId}/onboarding/card-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            card: JSON.parse(cardJson),
            values: createSampleCardValues(guildName, channelName),
          }),
        });
        if (!response.ok) throw new Error("preview unavailable");
        objectUrl = URL.createObjectURL(await response.blob());
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);
        setState("ready");
      } catch {
        if (!cancelled) {
          // Keep the last good frame visible during transient render/network
          // failures. The unavailable message is only shown before any frame
          // has ever rendered.
          setState("unavailable");
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cardJson, channelName, enabled, guildId, guildName]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  return { previewUrl, state };
}

/** Displays the same server-rendered PNG the bot posts. */
function ExactCardPreview({ card, previewUrl, state }: {
  card: CardConfig;
  previewUrl: string | null;
  state: ExactCardPreviewState["state"];
}) {
  return (
    <div
      className="relative w-full overflow-hidden rounded-xl border border-black/50 bg-[#071026]"
      style={{ aspectRatio: `${card.size.width} / ${card.size.height}` }}
      aria-busy={state === "loading"}
    >
      {previewUrl && <img src={previewUrl} alt="Exact rendered welcome card preview" className="absolute inset-0 h-full w-full" />}
      {state === "loading" && !previewUrl && (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-foam-300">Rendering exact card preview…</span>
      )}
      {state === "unavailable" && !previewUrl && (
        <span role="status" className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-amber-200">The exact card render is unavailable. Check the server’s image-rendering runtime.</span>
      )}
    </div>
  );
}

export function WelcomeCardDesigner({
  card,
  onChange,
  guildId,
  guildName = "your server",
  exactPreview,
}: {
  card: CardConfig | null;
  onChange: (next: CardConfig | null) => void;
  guildId: string;
  guildName?: string;
  exactPreview: ExactCardPreviewState;
}) {
  const active = normalizeCard(card);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "failed">("idle");
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [linkState, setLinkState] = useState<"idle" | "importing">("idle");

  const patch = (next: Partial<CardConfig>) => onChange({ ...active, ...next });
  const patchAvatar = (next: Partial<CardConfig["avatar"]>) => patch({ avatar: { ...active.avatar, ...next } });
  const moveAvatar = (xPct: number, yPct: number) => patchAvatar({
    xPct,
    yPct,
    x: undefined,
    y: undefined,
  });

  function startDrag(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    box.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      const xPct = Math.min(100, Math.max(0, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(100, Math.max(0, ((moveEvent.clientY - rect.top) / rect.height) * 100));
      moveAvatar(Math.round(xPct * 10) / 10, Math.round(yPct * 10) / 10);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  /** 512 KB of raw bytes per slice, ~683 KB once base64-wrapped. */
  const UPLOAD_CHUNK_CHARS = 512 * 1024;

  async function postUpload(body: unknown) {
    const response = await fetch(`/api/config/${guildId}/onboarding/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      uploadId?: string;
      error?: string;
      code?: string;
      chunk?: { id?: string };
    };
    return { response, payload };
  }

  /**
   * Every failure used to read "refused or storage is unavailable", which hid a
   * 413 from the host's proxy, an unreachable MongoDB and a policy rejection
   * behind one sentence. The route names the reason; this says what to do.
   */
  function uploadFailureMessage(status: number, payload: { error?: string; code?: string }) {
    if (status === 429) return "Too many uploads — wait a minute.";
    if (status === 413 || payload.error === "payload-too-large") {
      return "That file is over the limit this site accepts. Use an animated GIF under 10 MB, or a PNG/JPEG under 3 MB.";
    }
    if (status === 401) return "Your session expired — reload the page and sign in again.";
    if (status === 403) return "You do not have permission to change this server.";
    if (status === 409) return "That upload was interrupted — try again.";
    if (payload.error === "database-unavailable") {
      return "The site cannot reach its database, so nothing was stored. Check MONGODB_URI in website/.env.";
    }
    if (payload.error === "configuration") return "The site is missing its configuration; the upload cannot be stored yet.";
    if (payload.error === "invalid-upload") {
      if (payload.code === "UPLOAD_SIZE_INVALID") return "That image is too large once decoded.";
      if (payload.code === "UPLOAD_IMAGE_INVALID") return "That image could not be decoded — re-export it and try again.";
      if (payload.code === "UPLOAD_TYPE_INVALID") return "That file type cannot be used as a background.";
      return "That file is not a PNG, JPEG or GIF Nila can use.";
    }
    if (!payload.error) {
      return "The upload was blocked before it reached Nila — the host's proxy is refusing bodies of this size. Raise client_max_body_size (nginx) to 12m.";
    }
    return `The upload failed (${payload.error}).`;
  }

  async function uploadFile(file: File) {
    const budget = file.type === "image/gif" ? MAX_UPLOAD_GIF_BYTES : MAX_UPLOAD_BYTES;
    if (file.size >= budget) {
      setUploadMessage(file.type === "image/gif" ? "That GIF is not under 10 MB." : "That image is not under 3 MB.");
      setUploadState("failed");
      return;
    }
    setUploadState("uploading");
    setUploadMessage(null);
    const stored = () => {
      setUploadState("idle");
      setUploadMessage(
        file.type === "image/gif"
          ? "Animated background stored. The card plays this loop when a member joins."
          : "Background stored. The bot uses it when rendering each card.",
      );
    };
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("read"));
        reader.readAsDataURL(file);
      });
      // Small files go in one request. Anything larger is sliced, because a
      // reverse proxy with a 1 MB body limit would refuse the whole thing before
      // the route ever ran.
      if (dataBase64.length <= UPLOAD_CHUNK_CHARS) {
        const { response, payload } = await postUpload({ dataBase64, contentType: file.type });
        if (!response.ok || !payload.uploadId) {
          setUploadMessage(uploadFailureMessage(response.status, payload));
          setUploadState("failed");
          return;
        }
        patch({ uploadId: payload.uploadId, preset: null });
        stored();
        return;
      }
      const total = Math.ceil(dataBase64.length / UPLOAD_CHUNK_CHARS);
      let sessionId = "";
      for (let index = 0; index < total; index += 1) {
        setUploadMessage(`Uploading slice ${index + 1} of ${total}…`);
        const slice = dataBase64.slice(index * UPLOAD_CHUNK_CHARS, (index + 1) * UPLOAD_CHUNK_CHARS);
        const { response, payload } = await postUpload({
          chunk: { id: sessionId || undefined, index, total, dataBase64: slice, contentType: file.type },
        });
        if (!response.ok) {
          setUploadMessage(uploadFailureMessage(response.status, payload));
          setUploadState("failed");
          return;
        }
        if (index + 1 < total) {
          sessionId = payload.chunk?.id ?? sessionId;
          continue;
        }
        if (!payload.uploadId) {
          setUploadMessage("The upload finished but nothing was stored — try again.");
          setUploadState("failed");
          return;
        }
        patch({ uploadId: payload.uploadId, preset: null });
        stored();
      }
    } catch {
      setUploadMessage("The upload could not reach the site; nothing was stored.");
      setUploadState("failed");
    }
  }

  /**
   * Import a background from a link. The route downloads it once and stores the
   * bytes, so the card never depends on the remote host afterwards — which is
   * why an expiring Discord CDN link is still safe to use here.
   */
  async function importLink() {
    const url = linkValue.trim();
    if (url.length === 0) return;
    setLinkState("importing");
    setUploadMessage(null);
    try {
      const response = await fetch(`/api/config/${guildId}/onboarding/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const payload = (await response.json().catch(() => ({}))) as { uploadId?: string; error?: string };
      if (!response.ok || !payload.uploadId) {
        setUploadState("failed");
        setUploadMessage(
          response.status === 429
            ? "Too many imports — wait a minute."
            : payload.error === "source-unavailable"
              ? "That link could not be downloaded. Check it opens in a browser, then retry."
              : "That link is not a usable image. Use a direct https link to a PNG, JPEG or animated GIF.",
        );
        return;
      }
      patch({ uploadId: payload.uploadId, preset: null });
      setUploadState("idle");
      setLinkValue("");
      setUploadMessage("Background stored from that link. The bot uses it when rendering each card.");
    } catch {
      setUploadState("failed");
      setUploadMessage("The site could not reach that link; nothing was stored.");
    } finally {
      setLinkState("idle");
    }
  }

  return (
    <section className="glass-strong flex flex-col gap-3 rounded-2xl border border-line-strong p-5 shadow-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-white">
          <Move size={13} className="mr-1.5 inline text-cyan-glow-400" aria-hidden="true" />
          Welcome card
        </h3>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploadState === "uploading"}
            className="rounded-lg border border-white/20 bg-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/[0.15] hover:border-white/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            <ImagePlus size={12} className="mr-1.5 inline text-cyan-glow-300" aria-hidden="true" />
            {active.uploadId ? "Replace background" : "Upload background"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif"
            className="hidden"
            aria-label="Upload card background"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
              event.target.value = "";
            }}
          />
          {card !== null && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-300 hover:bg-red-500/20 hover:border-red-500/40 transition-all duration-200"
            >
              <Trash2 size={12} className="mr-1.5 inline" aria-hidden="true" />Remove card
            </button>
          )}
        </div>
      </div>

      {/* The editor surface is the exact PNG sent by Nila; only the avatar hit target is interactive. */}
      <div>
        <div
          ref={boxRef}
          className="relative w-full select-none overflow-hidden rounded-xl border border-white/20 bg-black/30 shadow-[0_0_0_1px_rgba(34,211,238,0.15)]"
          style={{ aspectRatio: `${active.size.width} / ${active.size.height}` }}
          aria-label="Welcome card designer preview"
          aria-busy={exactPreview.state === "loading"}
        >
          {exactPreview.previewUrl && <img src={exactPreview.previewUrl} alt="Exact welcome card rendered by Nila" className="absolute inset-0 h-full w-full" />}
          {!exactPreview.previewUrl && exactPreview.state === "loading" && (
            <span className="absolute inset-0 flex items-center justify-center text-xs text-foam-300">Rendering the card sent by Nila…</span>
          )}
          {!exactPreview.previewUrl && exactPreview.state === "unavailable" && (
            <span role="status" className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-amber-200">Exact card rendering is unavailable. Check the server image-rendering runtime.</span>
          )}
          <span
            role="slider"
            tabIndex={0}
            aria-label="Avatar position (drag, or use arrow keys)"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(active.avatar.xPct)}
            aria-valuetext={`x ${Math.round(active.avatar.xPct)}%, y ${Math.round(active.avatar.yPct)}%`}
            onPointerDown={startDrag}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 5 : 1;
              if (event.key === "ArrowLeft") moveAvatar(Math.max(0, active.avatar.xPct - step), active.avatar.yPct);
              else if (event.key === "ArrowRight") moveAvatar(Math.min(100, active.avatar.xPct + step), active.avatar.yPct);
              else if (event.key === "ArrowUp") moveAvatar(active.avatar.xPct, Math.max(0, active.avatar.yPct - step));
              else if (event.key === "ArrowDown") moveAvatar(active.avatar.xPct, Math.min(100, active.avatar.yPct + step));
              else return;
              event.preventDefault();
            }}
            className="absolute cursor-grab touch-none active:cursor-grabbing"
            style={{
              ...avatarGeometry(active),
              background: "transparent",
            }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-foam-500">
          Exact card render · sample: nova, {guildName}, 128 members. Drag the avatar or nudge it with arrow keys.
        </p>
      </div>

      {/* Background choices */}
      <div className="glass flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
        <span className="text-[11.5px] font-medium text-foam-300">Background:</span>
        {Object.entries(PRESET_SWATCHES).map(([preset, swatch]) => (
          <button
            key={preset}
            type="button"
            onClick={() => patch({ preset, uploadId: null })}
            aria-pressed={active.preset === preset && !active.uploadId}
            className={`h-11 w-16 shrink-0 rounded-lg border transition ${active.preset === preset && !active.uploadId ? "ring-2 ring-cyan-glow-400 border-cyan-glow-400" : "border-white/15 bg-white/[0.05] hover:border-white/20 hover:opacity-100"}`}
            style={{ backgroundImage: active.transparent ? "none" : swatch }}
            title={PRESET_TITLES[preset] ?? preset}
          >
            <span className="sr-only">{preset}</span>
          </button>
        ))}
        {active.uploadId && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
            <Check size={11} aria-hidden="true" className="text-emerald-400" /> custom background stored
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-[11.5px] text-foam-300">
          Dim
          <input
            type="range"
            min={0}
            max={80}
            value={active.backgroundDim}
            onChange={(event) => patch({ backgroundDim: Number(event.target.value) || 0 })}
            className="w-24 accent-cyan-glow-400"
            aria-label="Background dimming"
          />
          {active.backgroundDim}%
        </label>
      </div>

      {/* A link is an input method, not a storage mode: the site downloads it
          once, stores the bytes, and the bot never fetches it again. */}
      <div className="glass flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
        <span className="text-[11.5px] font-medium text-foam-300">Background link:</span>
        <input
          type="url"
          value={linkValue}
          onChange={(event) => setLinkValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void importLink();
            }
          }}
          placeholder="https://… direct link to a PNG, JPEG or GIF"
          aria-label="Background image link"
          className={`${inputClass} min-w-[240px] flex-1`}
        />
        <button
          type="button"
          onClick={() => void importLink()}
          disabled={linkState === "importing" || linkValue.trim().length === 0}
          className="rounded-lg border border-white/20 bg-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/[0.15] hover:border-white/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
        >
          <Link2 size={12} className="mr-1.5 inline text-cyan-glow-300" aria-hidden="true" />
          {linkState === "importing" ? "Importing…" : "Use link"}
        </button>
      </div>

      <div className="space-y-3 rounded-xl border border-white/10 p-3 text-sm"><label className="flex gap-2"><input type="checkbox" checked={active.transparent===true} onChange={e=>patch({transparent:e.target.checked})}/>Transparent background</label><label>Background fit<select className={inputClass} value={active.backgroundFit||"cover"} onChange={e=>patch({backgroundFit:e.target.value as CardConfig['backgroundFit']})}>{['cover','contain','stretch'].map(f=><option key={f}>{f}</option>)}</select></label><div className="grid grid-cols-2 gap-3">{(['width','height'] as const).map(key=><label key={key}>Canvas {key}<input className={inputClass} type="number" min={key==='width'?320:180} max={key==='width'?1920:1080} value={active.size[key]} onChange={e=>patch({size:{...active.size,[key]:Number(e.target.value)}})}/></label>)}</div><details><summary>Pixel positioning (top-left origin)</summary><div className="grid grid-cols-2 gap-2">{(['x','y','width','height'] as const).map(key=><label key={key}>Avatar {key}<input className={inputClass} type="number" min={0} max={1920} value={active.avatar[key]??''} onChange={e=>patchAvatar({[key]:e.target.value===''?undefined:Number(e.target.value)})}/></label>)}</div>{active.lines.map((line,index)=><fieldset key={index} className="mt-3 grid grid-cols-2 gap-2"><legend>Text layer {index+1}</legend>{(['x','y','fontSize','maxWidth'] as const).map(key=><label key={key}>{key}<input className={inputClass} type="number" min={0} max={1920} value={line[key]??''} onChange={e=>patch({lines:active.lines.map((item,i)=>i===index?{...item,[key]:e.target.value===''?undefined:Number(e.target.value)}:item)})}/></label>)}<label>Alignment<select className={inputClass} value={line.align||'center'} onChange={e=>patch({lines:active.lines.map((item,i)=>i===index?{...item,align:e.target.value as 'left'|'center'|'right'}:item)})}>{['left','center','right'].map(a=><option key={a}>{a}</option>)}</select></label></fieldset>)}</details></div>
      {/* Avatar shape + ring */}
      <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-foam-300">
        <span>Avatar:</span>
        {(["circle", "square", "rounded"] as const).map((shape) => (
          <button
            key={shape}
            type="button"
            onClick={() => patchAvatar({ shape })}
            aria-pressed={active.avatar.shape === shape}
            className={`min-h-11 rounded-md border px-3 py-2 capitalize ${active.avatar.shape === shape ? "border-river-400/50 bg-river-500/20 text-white" : "border-white/15 bg-white/5 hover:bg-white/10"}`}
          >
            {shape}
          </button>
        ))}
        <label className="flex items-center gap-1.5">
          ring
          <input
            type="color"
            value={active.avatar.ringColor ?? "#22d3ee"}
            onChange={(event) => patchAvatar({ ringColor: event.target.value })}
            className="h-6 w-8 cursor-pointer rounded border border-white/15 bg-transparent p-0"
            aria-label="Avatar ring color"
          />
          <button
            type="button"
            onClick={() => patchAvatar({ ringColor: active.avatar.ringColor ? null : "#22d3ee" })}
            className="min-h-11 min-w-11 rounded-md border border-white/15 bg-white/5 px-3 py-2 hover:bg-white/10"
          >
            {active.avatar.ringColor ? "off" : "on"}
          </button>
        </label>
        <label className="flex items-center gap-1.5">
          size
          <input
            type="range"
            min={10}
            max={80}
            value={active.avatar.sizePct}
            onChange={(event) => patchAvatar({ sizePct: Number(event.target.value) || 45, width: undefined, height: undefined })}
            className="w-24 accent-[#5865f2]"
            aria-label="Avatar size percent"
          />
          {active.avatar.sizePct}%
        </label>
      </div>

      {/* Lines */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] font-medium text-foam-300">Text lines ({active.lines.length}/4)</span>
          {active.lines.length < 4 && (
            <button
              type="button"
              onClick={() => patch({ lines: [...active.lines, { text: "New line", xPct: 50, yPct: 85, sizePct: 6, color: "#f1f6ff", weight: "regular" }] })}
              className="min-h-11 px-2 text-[11.5px] font-semibold text-cyan-glow-300 hover:text-white"
            >
              + Add line
            </button>
          )}
        </div>
        {active.lines.map((line, index) => (
          <div key={index} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
            <div className="flex items-center gap-2">
              <input
                value={line.text}
                onChange={(event) => {
                  const lines = active.lines.map((entry, i) => (i === index ? { ...entry, text: event.target.value } : entry));
                  patch({ lines });
                }}
                aria-label={`Card line ${index + 1} text`}
                placeholder="Welcome {user}!"
                className={`${inputClass} min-w-0 flex-1 !py-1.5 text-[12.5px]`}
              />
              <input
                type="color"
                value={line.color}
                onChange={(event) => {
                  const lines = active.lines.map((entry, i) => (i === index ? { ...entry, color: event.target.value } : entry));
                  patch({ lines });
                }}
                aria-label={`Card line ${index + 1} color`}
                className="h-7 w-9 shrink-0 cursor-pointer rounded border border-white/15 bg-transparent p-0"
              />
              <button
                type="button"
                onClick={() => patch({ lines: active.lines.filter((_, i) => i !== index) })}
                aria-label={`Remove card line ${index + 1}`}
                disabled={active.lines.length <= 1}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1.5 text-red-400 hover:bg-red-500/15 disabled:opacity-30"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-foam-400">
              <label className="flex items-center gap-1.5">x
                <input type="range" min={0} max={100} value={line.xPct}
                  onChange={(event) => patch({ lines: active.lines.map((entry, i) => (i === index ? { ...entry, xPct: Number(event.target.value), x: undefined } : entry)) })}
                  className="w-20 accent-[#5865f2]" aria-label={`Card line ${index + 1} x position`} />
              </label>
              <label className="flex items-center gap-1.5">y
                <input type="range" min={0} max={100} value={line.yPct}
                  onChange={(event) => patch({ lines: active.lines.map((entry, i) => (i === index ? { ...entry, yPct: Number(event.target.value), y: undefined } : entry)) })}
                  className="w-20 accent-[#5865f2]" aria-label={`Card line ${index + 1} y position`} />
              </label>
              <label className="flex items-center gap-1.5">size
                <input type="range" min={3} max={30} value={line.sizePct}
                  onChange={(event) => patch({ lines: active.lines.map((entry, i) => (i === index ? { ...entry, sizePct: Number(event.target.value), fontSize: undefined } : entry)) })}
                  className="w-20 accent-[#5865f2]" aria-label={`Card line ${index + 1} size`} />
              </label>
              <label className="flex items-center gap-1.5">spacing
                <input type="range" min={0} max={20} value={line.letterSpacing ?? 0}
                  onChange={(event) => patch({ lines: active.lines.map((entry, i) => (i === index ? { ...entry, letterSpacing: Number(event.target.value) || undefined } : entry)) })}
                  className="w-20 accent-[#5865f2]" aria-label={`Card line ${index + 1} letter spacing`} />
              </label>
              <button
                type="button"
                onClick={() => patch({ lines: active.lines.map((entry, i) => (i === index ? { ...entry, weight: entry.weight === "bold" ? "regular" : "bold" } : entry)) })}
                className="min-h-11 rounded border border-white/15 bg-white/5 px-3 py-2"
                aria-pressed={line.weight === "bold"}
              >
                bold
              </button>
            </div>
          </div>
        ))}
      </div>

      {uploadMessage && (
        <p role="status" className={`text-[11.5px] ${uploadState === "failed" ? "text-amber-200" : "text-emerald-200"}`}>
          {uploadMessage}
        </p>
      )}
    </section>
  );
}
