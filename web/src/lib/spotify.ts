import fs from "node:fs";
import path from "node:path";
import { createStateToken, publicBaseUrl } from "./urls";
import { writeJsonFile } from "./store";

/**
 * Spotify Web API client (Authorization Code flow). The backend acts as the
 * owner's Spotify account — one household login, linked once by an admin via
 * /api/spotify/login. The prize: Spotify Connect can target ANY of the
 * house's Connect endpoints, including the Control4 Core's per-zone
 * "Spotify C4 <Room>" devices that no other integration can reach — so the
 * app's Play button works in matrix-only rooms (Kitchen, Terrace, …).
 *
 * The refresh token lives in a JSON file (point SPOTIFY_TOKEN_PATH at the
 * persistent volume in production, same pattern as USERS_PATH/SCENES_PATH).
 * Spotify's rule, not ours: one account plays in one place at a time —
 * playing in the Kitchen moves the session there.
 */

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";

/** Room -> Spotify Connect device name. C4 zones announce as "Spotify C4 …"
 * with the Core's own room naming, which differs from ours in two places. */
const ROOM_DEVICE: Record<string, string> = {
  "Den": "Spotify C4 Den",
  "Lounge": "Spotify C4 Lounge",
  "Kitchen": "Spotify C4 Kitchen",
  "Terrace": "Spotify C4 Terrace",
  "Balcony (6th)": "Spotify C4 Balcony",
  "Master Bedroom": "Spotify C4 MBR",
  "Master Bathroom": "Spotify C4 Master Bathroom",
  "Master Bedroom Balcony": "Spotify C4 Master Bedroom Balcony",
};

export function spotifyConfigured(): boolean {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/**
 * The redirect URI must byte-match the Spotify dashboard entry. Never derive
 * it from the request: behind Railway's proxy, nextUrl.origin resolves to
 * the internal host — Spotify answered "redirect_uri: Not matching
 * configuration" to the owner's very first link attempt. publicBaseUrl
 * (lib/urls.ts) encodes that rule; no request origin is passed here, so it
 * throws rather than guess.
 */
export function spotifyRedirectUri(): string {
  return `${publicBaseUrl()}/api/spotify/callback`;
}

function tokenPath(): string {
  return process.env.SPOTIFY_TOKEN_PATH || path.join(process.cwd(), "spotify_token.json");
}

export function spotifyLinked(): boolean {
  try {
    return !!JSON.parse(fs.readFileSync(tokenPath(), "utf8")).refresh_token;
  } catch {
    return false;
  }
}

function saveRefreshToken(refreshToken: string): void {
  writeJsonFile(tokenPath(), { refresh_token: refreshToken });
}

function basicAuth(): string {
  return Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");
}

// ---- OAuth ----

/** The state is an HMAC-signed token (lib/urls.ts) — stateless, so the link
 *  survives a deploy mid-flow and works across instances. */
export function authUrl(redirectUri: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    scope: "user-read-playback-state user-modify-playback-state",
    redirect_uri: redirectUri,
    state: createStateToken("spotify-link"),
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const out = (await res.json()) as { refresh_token?: string; error_description?: string };
  if (!res.ok || !out.refresh_token) {
    throw new Error(out.error_description ?? `token exchange failed (HTTP ${res.status})`);
  }
  saveRefreshToken(out.refresh_token);
  cachedAccess = null;
}

// ---- Access tokens ----

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt - 30_000) return cachedAccess.token;
  let refresh: string;
  try {
    refresh = JSON.parse(fs.readFileSync(tokenPath(), "utf8")).refresh_token;
  } catch {
    throw new Error("Spotify is not linked — an admin can link it from the More page");
  }
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const out = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error_description?: string;
  };
  if (!res.ok || !out.access_token) {
    throw new Error(out.error_description ?? `token refresh failed (HTTP ${res.status})`);
  }
  // Spotify may rotate the refresh token; keep the newest.
  if (out.refresh_token) saveRefreshToken(out.refresh_token);
  cachedAccess = {
    token: out.access_token,
    expiresAt: Date.now() + (out.expires_in ?? 3600) * 1000,
  };
  return cachedAccess.token;
}

async function api(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* 204s have no body */
  }
  return { status: res.status, json };
}

// ---- Playback ----

export function roomDeviceName(room: string): string | null {
  return ROOM_DEVICE[room] ?? null;
}

interface ConnectDevice {
  id: string;
  name: string;
  is_active: boolean;
}

async function findDevice(name: string): Promise<ConnectDevice> {
  const { status, json } = await api("GET", "/me/player/devices");
  if (status !== 200) throw new Error(`could not list Spotify devices (HTTP ${status})`);
  const devices = ((json as { devices?: ConnectDevice[] })?.devices ?? []);
  const dev = devices.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!dev) {
    throw new Error(`"${name}" is not visible to Spotify right now`);
  }
  return dev;
}

/** Reverse of ROOM_DEVICE: which app room a Connect device name belongs to. */
export function deviceRoom(deviceName: string): string | null {
  const hit = Object.entries(ROOM_DEVICE).find(
    ([, name]) => name.toLowerCase() === deviceName.toLowerCase(),
  );
  return hit ? hit[0] : null;
}

export interface NowPlaying {
  playing: boolean;
  track: string | null;
  artist: string | null;
  artUrl: string | null;
  deviceName: string | null;
  /** App room of the playing device, when it maps to one of ours. */
  room: string | null;
}

/** The account's current session, cached briefly — every open room page
 *  polls this and Spotify's API doesn't owe us that traffic. */
let nowCache: { at: number; value: NowPlaying } | null = null;

export async function nowPlaying(): Promise<NowPlaying> {
  if (nowCache && Date.now() - nowCache.at < 5000) return nowCache.value;
  const idle: NowPlaying = { playing: false, track: null, artist: null, artUrl: null, deviceName: null, room: null };
  const { status, json } = await api("GET", "/me/player");
  let value = idle;
  if (status === 200 && json) {
    const p = json as {
      is_playing?: boolean;
      item?: { name?: string; artists?: { name?: string }[]; album?: { images?: { url?: string; width?: number }[] } };
      device?: { name?: string };
    };
    const images = p.item?.album?.images ?? [];
    // Smallest image ≥64px — the card thumbnail is tiny.
    const art = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 0) >= 64) ?? images[0];
    const deviceName = p.device?.name ?? null;
    value = {
      playing: !!p.is_playing,
      track: p.item?.name ?? null,
      artist: p.item?.artists?.map((a) => a.name).filter(Boolean).join(", ") || null,
      artUrl: art?.url ?? null,
      deviceName,
      room: deviceName ? deviceRoom(deviceName) : null,
    };
  }
  nowCache = { at: Date.now(), value };
  return value;
}

/** Skip within the account's active session (device-independent — the C4
 *  zones can't skip through HA, but Spotify's API can always). */
export async function skip(direction: "next" | "previous"): Promise<void> {
  const { status, json } = await api("POST", `/me/player/${direction}`);
  if (status !== 200 && status !== 204) {
    const reason = (json as { error?: { message?: string } })?.error?.message;
    throw new Error(reason ?? `skip failed (HTTP ${status})`);
  }
  nowCache = null; // the track just changed; don't serve the stale one
}

/**
 * Make the owner's Spotify play in a room. Resume-first: targeting the
 * device with a bare play resumes the account's last context there; if
 * Spotify refuses (cold start, no session anywhere), fall back to the
 * configured default (SPOTIFY_DEFAULT_CONTEXT, e.g. a playlist URI).
 */
export async function playInRoom(room: string): Promise<string> {
  const name = roomDeviceName(room);
  if (!name) throw new Error(`no Spotify endpoint mapped for ${room}`);
  const dev = await findDevice(name);
  const play = await api("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`);
  if (play.status === 202 || play.status === 204 || play.status === 200) return dev.name;
  const fallback = process.env.SPOTIFY_DEFAULT_CONTEXT;
  if (fallback) {
    const ctx = await api("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`, {
      context_uri: fallback,
    });
    if (ctx.status === 202 || ctx.status === 204 || ctx.status === 200) return dev.name;
  }
  const reason = (play.json as { error?: { message?: string } })?.error?.message;
  throw new Error(
    reason ?? "Spotify had nothing to resume — set SPOTIFY_DEFAULT_CONTEXT or start once from the Spotify app",
  );
}
