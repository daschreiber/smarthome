/**
 * Adapter for the white-noise machine (daschreiber/whitenoise, its own
 * Railway service). Division of labor per that repo's README: Control4 owns
 * on/off (the bedside button connects/disconnects the bedroom zone), the
 * noise server owns the SOUND (type + volume of the endless stream), and
 * `listeners` tells the truth about whether anything is actually playing.
 * This module is the only code that talks to it.
 */

const TIMEOUT_MS = 5000;

export type NoiseType = "white" | "brown" | "pink";

export interface NoiseStatus {
  noiseType: NoiseType;
  volume: number;
  listeners: number;
}

export function noiseConfigured(): boolean {
  return Boolean(process.env.WHITENOISE_BASE_URL && process.env.WHITENOISE_TOKEN);
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
 * stream. On/off is done by telling this Control4 zone to play (or stop) the
 * stream URL — no bedside button required. Defaults to the Master Bedroom.
 */
export function noiseMediaEntity(): string {
  return process.env.WHITENOISE_MEDIA_ENTITY || "media_player.master_bedroom";
}

/** The token-bearing stream URL the zone connects to. Server-side only —
 *  it carries the token and must never reach the browser. */
export function noiseStreamUrl(): string {
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

export async function noiseStatus(): Promise<NoiseStatus> {
  return call("/api/status", "GET");
}

export async function setNoiseType(type: NoiseType): Promise<NoiseStatus> {
  return call(`/api/noise/${type}`, "POST");
}

export async function setNoiseVolume(volume: number): Promise<NoiseStatus> {
  const v = Math.min(100, Math.max(0, Math.round(volume)));
  return call(`/api/volume/${v}`, "POST");
}
