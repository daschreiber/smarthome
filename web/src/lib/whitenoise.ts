/**
 * Adapter for the white-noise machine (daschreiber/whitenoise). Two shapes:
 *
 * - Direct mode: the noise server is reachable from this app (the original
 *   Railway deployment). WHITENOISE_BASE_URL + WHITENOISE_TOKEN; this module
 *   calls its API straight.
 * - Via-HA mode (WHITENOISE_VIA_HA): the noise server runs as a Home
 *   Assistant add-on on the LAN, serving plain HTTP because the bedroom
 *   Yamaha's MusicCast player cannot do TLS (COMMISSIONING_LOG 2026-07-22).
 *   This app runs in the cloud and can't reach the LAN, so sound control and
 *   status ride through HA: rest_command.whitenoise_set_noise /
 *   whitenoise_set_volume, and sensor.white_noise_status (a REST sensor
 *   mirroring /api/status). Those live in configuration.yaml on the Green.
 *
 * Either way `listeners` tells the truth about whether anything is actually
 * playing, and on/off is the room's media_player joining/leaving the stream.
 */

import { callService, getState } from "./ha";

const TIMEOUT_MS = 5000;

/** The HA REST sensor that mirrors the add-on's /api/status. */
const STATUS_ENTITY = "sensor.white_noise_status";

export type NoiseType = "white" | "brown" | "pink";

export interface NoiseStatus {
  noiseType: NoiseType;
  volume: number;
  listeners: number;
}

/** True when sound control goes through Home Assistant (LAN add-on mode). */
function noiseViaHa(): boolean {
  const v = (process.env.WHITENOISE_VIA_HA ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function noiseConfigured(): boolean {
  return noiseViaHa() || Boolean(process.env.WHITENOISE_BASE_URL && process.env.WHITENOISE_TOKEN);
}

/**
 * The service's base URL, normalized. Railway (and most hosts) show the domain
 * without a scheme, so a bare `host.up.railway.app` is an easy paste — but then
 * fetch() and the stream URL both choke with "Failed to parse URL". Prepend
 * https:// when no scheme is present, and drop any trailing slash. Returns ""
 * when unset so callers can still detect the not-configured case.
 */
function noiseBaseUrl(): string {
  const raw = (process.env.WHITENOISE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * The Home Assistant media_player entity for the room whose speakers play the
 * stream. On/off is done by telling this zone to play (or stop) the stream
 * URL. The bedroom speakers are the Yamaha's MAIN zone,
 * media_player.master_bedroom_2 — set WHITENOISE_MEDIA_ENTITY accordingly
 * (the historical default is kept for compatibility).
 */
export function noiseMediaEntity(): string {
  return process.env.WHITENOISE_MEDIA_ENTITY || "media_player.master_bedroom";
}

/**
 * Control4 is a source/zone matrix: rooms JOIN sources, they don't play URLs
 * (its HA integration ignores play_media). When the stream is programmed into
 * Control4 as a source (web-radio/station driver), set this to that source's
 * name and "on" becomes select_source on the room — the operation the matrix
 * actually understands. Unset = fall back to play_media with the stream URL,
 * which works on entities that accept URLs (DLNA renderers, Sonos, Cast…).
 */
export function noiseMediaSource(): string | null {
  return process.env.WHITENOISE_MEDIA_SOURCE || null;
}

/**
 * The token-bearing stream URL the zone connects to. WHITENOISE_STREAM_URL
 * wins when set — in via-HA mode that's the add-on's LAN plain-HTTP URL
 * (`http://<green>:8099/stream?token=…`), which the Yamaha can actually play;
 * the HTTPS fallback built from the base URL is only for TLS-capable players.
 * Server-side only — it carries the token and must never reach the browser.
 */
export function noiseStreamUrl(): string {
  const explicit = (process.env.WHITENOISE_STREAM_URL ?? "").trim();
  if (explicit) return explicit;
  const base = noiseBaseUrl();
  const token = process.env.WHITENOISE_TOKEN ?? "";
  return `${base}/stream?token=${encodeURIComponent(token)}`;
}

async function call(path: string, method: "GET" | "POST"): Promise<NoiseStatus> {
  const base = noiseBaseUrl();
  const token = process.env.WHITENOISE_TOKEN ?? "";
  if (!base || !token) throw new Error("white noise is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(body.detail ?? `noise API HTTP ${res.status}`));
    }
    return {
      noiseType: (body.noise_type as NoiseType) ?? "white",
      volume: Number(body.volume ?? 0),
      listeners: Number(body.listeners ?? 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the mirrored status out of the HA REST sensor's attributes. */
async function statusFromSensor(): Promise<NoiseStatus> {
  const s = await getState(STATUS_ENTITY);
  if (!s) throw new Error(`${STATUS_ENTITY} not found — is the rest sensor configured in HA?`);
  const a = s.attributes;
  return {
    noiseType: (a.noise_type as NoiseType) ?? "white",
    volume: Number(a.volume ?? 0),
    listeners: Number(a.listeners ?? 0),
  };
}

export async function noiseStatus(): Promise<NoiseStatus> {
  if (noiseViaHa()) return statusFromSensor();
  return call("/api/status", "GET");
}

/**
 * Status with freshness guaranteed. The REST sensor polls every 60s, which is
 * fine for display but useless for verifying an on/off command; force an
 * update first. In direct mode a status call is always fresh.
 */
export async function noiseStatusFresh(): Promise<NoiseStatus> {
  if (!noiseViaHa()) return call("/api/status", "GET");
  await callService("homeassistant", "update_entity", { entity_id: STATUS_ENTITY });
  return statusFromSensor();
}

/**
 * Start playback on the room's speakers — the ONE way noise turns on, used
 * by the command route, scenes/automations, and the sleep watcher alike.
 * Speaks both dialects: select_source when the stream is a programmed
 * Control4 source, play_media with the URL otherwise (MusicCast, DLNA…).
 * Fire-and-forget at this layer: the noise server's listener count is the
 * ground truth for whether sound actually started.
 */
export async function noiseTurnOn(): Promise<void> {
  const source = noiseMediaSource();
  if (source) {
    await callService("media_player", "select_source", {
      entity_id: noiseMediaEntity(),
      source,
    });
  } else {
    await callService("media_player", "play_media", {
      entity_id: noiseMediaEntity(),
      media_content_id: noiseStreamUrl(),
      media_content_type: "music",
    });
  }
}

/**
 * When playback was last stopped ON PURPOSE through this module — the app,
 * a scene, an automation, the assistant, or the watcher itself. The sleep
 * watcher's early-death retry exists to fight streams that die on their own
 * (the 2026-07-22 receiver mystery), and it discriminates by this mark: a
 * silent stream with a commanded stop after the watcher's start is a human
 * choice, never interference (it relit the noise in the owner's face on the
 * 2026-08-13 morning). In-memory on purpose — single service, same as
 * knxLights' claims; its 3-minute relevance doesn't survive a deploy anyway.
 */
let commandedStopAtMs: number | null = null;

export function noiseStoppedAtMs(): number | null {
  return commandedStopAtMs;
}

/** Test seam only. */
export function resetNoiseStoppedAt(): void {
  commandedStopAtMs = null;
}

/** Stop playback: the room's media_player goes off/standby. */
export async function noiseTurnOff(): Promise<void> {
  await callService("media_player", "turn_off", { entity_id: noiseMediaEntity() });
  // Only a stop that actually went out counts — a thrown call marks nothing.
  commandedStopAtMs = Date.now();
}

export async function setNoiseType(type: NoiseType): Promise<NoiseStatus> {
  if (noiseViaHa()) {
    await callService("rest_command", "whitenoise_set_noise", { noise_type: type });
    return noiseStatusFresh();
  }
  return call(`/api/noise/${type}`, "POST");
}

export async function setNoiseVolume(volume: number): Promise<NoiseStatus> {
  const v = Math.min(100, Math.max(0, Math.round(volume)));
  if (noiseViaHa()) {
    await callService("rest_command", "whitenoise_set_volume", { volume: v });
    return noiseStatusFresh();
  }
  return call(`/api/volume/${v}`, "POST");
}
