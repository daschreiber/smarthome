import { createStateToken, publicBaseUrl } from "./urls";
import {
  HOUSE, accountLabel, allAccounts, refreshTokenFor, updateRefreshToken,
  type AccountKey,
} from "./spotifyAccounts";

/**
 * Spotify Web API client (Authorization Code flow), account-aware.
 *
 * The prize is still the same: Spotify Connect can target ANY of the
 * house's Connect endpoints, including the Control4 Core's per-zone
 * "Spotify C4 <Room>" devices that no other integration can reach — so the
 * app's Play button works in matrix-only rooms (Kitchen, Terrace, …).
 *
 * What changed: every call now names the account it acts as. Spotify allows
 * one playback session per ACCOUNT, which is why the single household login
 * could never play two rooms at once — the Kitchen always stole the Lounge.
 * With each person linking their own Spotify (lib/spotifyAccounts), two
 * people are two sessions and the rooms are independent.
 *
 * Token caching is per account and in-memory; refresh tokens live in the
 * stores. Spotify may rotate a refresh token on use, so every refresh
 * writes the newest one back.
 */

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";

/**
 * Room -> Spotify Connect device name. The Core announces its zones with
 * its own room naming, which differs from ours in a few places, so the map
 * is explicit. It is the FIRST resolution strategy, not the only one:
 * resolveDevice() falls back to fuzzy matching, because a zone renamed in
 * Composer would otherwise silently break the room's Play button with no
 * way to tell from the app (docs/AUDIO_SYSTEM.md, Terrace).
 */
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

/**
 * Extra spellings a zone may carry in the Core. Composer names are typed by
 * hand at install time and abbreviate unpredictably ("MBR", "Bath"), so a
 * room's device is matched against these too before we call it missing.
 */
const ROOM_ALIASES: Record<string, string[]> = {
  "Balcony (6th)": ["Balcony", "Balcony 6th", "6th Balcony", "Balcony Speakers"],
  "Master Bedroom": ["MBR", "Master Bed"],
  "Master Bathroom": ["Master Bath", "MBR Bathroom", "MBR Bath"],
  "Master Bedroom Balcony": ["MBR Balcony", "Master Balcony"],
  "Terrace": ["Terrace Speakers", "Roof Terrace"],
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

/** Is the HOUSE account linked? (Per-user links: spotifyAccounts.getLink.) */
export function spotifyLinked(): boolean {
  return refreshTokenFor(HOUSE) != null;
}

function basicAuth(): string {
  return Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");
}

// ---- OAuth ----

/** Who a consent flow is for; rides signed inside the OAuth state. */
export type LinkTarget = { kind: "house" } | { kind: "user"; email: string };

export function linkSubject(target: LinkTarget): string {
  return target.kind === "house" ? "house" : `user:${target.email.toLowerCase()}`;
}

/**
 * Scopes: playback read + control is the job. user-read-private comes along
 * so the link can store a display name ("Ruth's Spotify") and the account's
 * product tier — Connect control is Premium-only, and saying that plainly
 * at link time beats a mystifying 403 at the first Play.
 */
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-private";

/** The state is an HMAC-signed token (lib/urls.ts) — stateless, so the link
 *  survives a deploy mid-flow and works across instances, and it carries
 *  WHICH account is being linked where a user can't tamper with it. */
export function authUrl(redirectUri: string, target: LinkTarget = { kind: "house" }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state: createStateToken("spotify-link", Date.now(), linkSubject(target)),
    // A second person consenting on a shared phone must get the Spotify
    // login screen, not a silent re-approve of whoever is already signed in.
    show_dialog: "true",
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

/** Trade the consent code for a refresh token. The caller decides where it
 *  is stored (house file vs per-user link) — this only talks to Spotify. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const out = (await res.json()) as {
    refresh_token?: string; access_token?: string; error_description?: string;
  };
  if (!res.ok || !out.refresh_token || !out.access_token) {
    throw new Error(out.error_description ?? `token exchange failed (HTTP ${res.status})`);
  }
  return { refreshToken: out.refresh_token, accessToken: out.access_token };
}

// ---- Access tokens ----

const cachedAccess = new Map<AccountKey, { token: string; expiresAt: number }>();

/** Drop a cached access token (after unlink/relink, so a stale one can't
 *  keep acting as an account the user just disconnected). */
export function forgetAccount(key: AccountKey): void {
  cachedAccess.delete(key);
}

async function accessToken(key: AccountKey): Promise<string> {
  const hit = cachedAccess.get(key);
  if (hit && Date.now() < hit.expiresAt - 30_000) return hit.token;
  const refresh = refreshTokenFor(key);
  if (!refresh) {
    throw new Error(
      key === HOUSE
        ? "Spotify is not linked — an admin can link it from the More page"
        : "your Spotify isn't linked — connect it from More → Spotify",
    );
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
  if (out.refresh_token) updateRefreshToken(key, out.refresh_token);
  const entry = { token: out.access_token, expiresAt: Date.now() + (out.expires_in ?? 3600) * 1000 };
  cachedAccess.set(key, entry);
  return entry.token;
}

async function api(
  method: string,
  p: string,
  key: AccountKey = HOUSE,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(key)}`,
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

/** Spotify's own words for a failure, when it bothered to give them. */
function reasonFrom(json: unknown, fallback: string): string {
  const message = (json as { error?: { message?: string } })?.error?.message;
  return message || fallback;
}

// ---- Accounts ----

export interface SpotifyProfile {
  /** Spotify's own user id — the unit its authorised-user limit counts in
   *  (spotifyAccounts.usedSlots), so the house account linked personally by
   *  the same admin doesn't burn two of five slots. */
  id: string | null;
  displayName: string | null;
  premium: boolean | null;
}

/** Read /me with an access token we already hold (used during linking,
 *  before the token has been filed under an account key). */
export async function profileWithToken(accessTok: string): Promise<SpotifyProfile> {
  const unknown: SpotifyProfile = { id: null, displayName: null, premium: null };
  try {
    const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${accessTok}` } });
    if (!res.ok) return unknown;
    const out = (await res.json()) as { id?: string; display_name?: string; product?: string };
    return {
      id: out.id || null,
      displayName: out.display_name || null,
      premium: out.product ? out.product === "premium" : null,
    };
  } catch {
    return unknown;
  }
}

// ---- Device resolution ----

export function roomDeviceName(room: string): string | null {
  return ROOM_DEVICE[room] ?? null;
}

interface ConnectDevice {
  id: string;
  name: string;
  is_active: boolean;
}

/** Comparable form: drop the "Spotify C4" prefix the Core prepends, and all
 *  punctuation/spacing, so "Spotify C4 MBR" and "mbr" meet in the middle. */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^spotify\s*(c4|control ?4)?\s*/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function candidateNames(room: string): string[] {
  return [ROOM_DEVICE[room], room, ...(ROOM_ALIASES[room] ?? [])].filter(Boolean) as string[];
}

export async function listDevices(key: AccountKey = HOUSE): Promise<ConnectDevice[]> {
  const { status, json } = await api("GET", "/me/player/devices", key);
  if (status !== 200) {
    throw new Error(reasonFrom(json, `could not list Spotify devices (HTTP ${status})`));
  }
  return (json as { devices?: ConnectDevice[] })?.devices ?? [];
}

/**
 * Find the room's Connect endpoint among the devices this account can see.
 * Exact mapped name first, then normalized name/alias matching.
 *
 * When nothing matches, the error NAMES what Spotify could see. That is the
 * difference between "the Terrace won't connect" and a fixable fact: a zone
 * renamed in Composer, or a zone genuinely absent from the picker because
 * this account has never selected it on the house Wi-Fi.
 */
async function resolveDevice(room: string, key: AccountKey): Promise<ConnectDevice> {
  const devices = await listDevices(key);
  const wanted = candidateNames(room).map(normalizeName);
  const matches = devices.filter((d) => wanted.includes(normalizeName(d.name)));
  const dev =
    devices.find((d) => d.name.toLowerCase() === (ROOM_DEVICE[room] ?? "").toLowerCase()) ??
    // Among fuzzy matches, a Core zone beats anything else with a similar
    // name. It matters on the balconies: the un-cabled VSSL amp announces
    // "MBR balcony", which normalizes onto the same room as the Core's
    // zone and would otherwise win and send Play into a dead streamer.
    matches.find((d) => /^spotify\s*c4\b/i.test(d.name)) ??
    matches[0];
  if (!dev) {
    const seen = devices.map((d) => d.name).join(", ");
    throw new Error(
      `"${ROOM_DEVICE[room] ?? room}" is not visible to Spotify right now. ` +
        (seen
          ? `Spotify can see: ${seen}. Open Spotify on this phone, pick the ${room} once, then try again.`
          : `This account sees no Spotify devices at all — open Spotify on the home Wi-Fi first.`),
    );
  }
  return dev;
}

/** Reverse of ROOM_DEVICE: which app room a Connect device name belongs to. */
export function deviceRoom(deviceName: string): string | null {
  const exact = Object.entries(ROOM_DEVICE).find(
    ([, name]) => name.toLowerCase() === deviceName.toLowerCase(),
  );
  if (exact) return exact[0];
  const norm = normalizeName(deviceName);
  // Only rooms we map are candidates — the Sonos "Gym" and the Yamahas are
  // real Connect devices but not matrix zones, and must not be claimed.
  const fuzzy = Object.keys(ROOM_DEVICE).find((room) =>
    candidateNames(room).map(normalizeName).includes(norm),
  );
  return fuzzy ?? null;
}

// ---- Now playing ----

export interface NowPlaying {
  playing: boolean;
  track: string | null;
  artist: string | null;
  artUrl: string | null;
  deviceName: string | null;
  /** App room of the playing device, when it maps to one of ours. */
  room: string | null;
}

const IDLE: NowPlaying = {
  playing: false, track: null, artist: null, artUrl: null, deviceName: null, room: null,
};

/** Per-account session cache — every open room page polls, and Spotify's
 *  API doesn't owe us that traffic (Development Mode quota is shared across
 *  a developer account since Feb 2026, so this matters more than it did). */
const nowCache = new Map<AccountKey, { at: number; value: NowPlaying }>();
const NOW_TTL_MS = 5000;
/** Requests already in the air, so a cold cache asked twice at once (the
 *  /api/music/now route wants `mine` and the room sweep together) costs one
 *  Spotify call, not two. */
const nowInFlight = new Map<AccountKey, Promise<NowPlaying>>();

export async function nowPlaying(key: AccountKey = HOUSE): Promise<NowPlaying> {
  const hit = nowCache.get(key);
  if (hit && Date.now() - hit.at < NOW_TTL_MS) return hit.value;
  const flying = nowInFlight.get(key);
  if (flying) return flying;
  const request = fetchNowPlaying(key).finally(() => nowInFlight.delete(key));
  nowInFlight.set(key, request);
  return request;
}

async function fetchNowPlaying(key: AccountKey): Promise<NowPlaying> {
  const { status, json } = await api("GET", "/me/player", key);
  let value = IDLE;
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
  nowCache.set(key, { at: Date.now(), value });
  return value;
}

export interface RoomSession extends NowPlaying {
  room: string;
  /** Whose account holds it — "Ruth's Spotify". */
  who: string;
  account: AccountKey;
}

/**
 * Every room that currently has a session, across every linked account —
 * this is what makes "Spotify is in the Lounge" true house-wide instead of
 * only for whoever linked first.
 *
 * Cached house-wide (not per caller): N accounts × every open phone would
 * otherwise multiply into real quota. One sweep every 8s serves everyone.
 */
let sessionsCache: { at: number; value: RoomSession[] } | null = null;
const SESSIONS_TTL_MS = 8000;

export async function roomSessions(): Promise<RoomSession[]> {
  if (sessionsCache && Date.now() - sessionsCache.at < SESSIONS_TTL_MS) return sessionsCache.value;
  const keys = allAccounts();
  const results = await Promise.allSettled(keys.map((k) => nowPlaying(k)));
  const out: RoomSession[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const n = r.value;
    if (!n.room || (!n.playing && !n.track)) return;
    out.push({ ...n, room: n.room, who: accountLabel(keys[i]), account: keys[i] });
  });
  sessionsCache = { at: Date.now(), value: out };
  return out;
}

/** Invalidate the caches a command just made stale. */
function invalidate(key: AccountKey): void {
  nowCache.delete(key);
  sessionsCache = null;
}

// ---- Playback ----

export async function skip(direction: "next" | "previous", key: AccountKey = HOUSE): Promise<void> {
  const { status, json } = await api("POST", `/me/player/${direction}`, key);
  if (status !== 200 && status !== 204) {
    throw new Error(reasonFrom(json, `skip failed (HTTP ${status})`));
  }
  invalidate(key); // the track just changed; don't serve the stale one
}

/**
 * Make an account play in a room. Resume-first: targeting the device with a
 * bare play resumes that account's last context there; if Spotify refuses
 * (cold start, no session anywhere), fall back to the configured default
 * (SPOTIFY_DEFAULT_CONTEXT, e.g. a playlist URI).
 */
export async function playInRoom(room: string, key: AccountKey = HOUSE): Promise<string> {
  const name = roomDeviceName(room);
  if (!name) throw new Error(`no Spotify endpoint mapped for ${room}`);
  const dev = await resolveDevice(room, key);
  const play = await api("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`, key);
  if (play.status === 202 || play.status === 204 || play.status === 200) {
    invalidate(key);
    return dev.name;
  }
  const fallback = process.env.SPOTIFY_DEFAULT_CONTEXT;
  if (fallback) {
    const ctx = await api("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`, key, {
      context_uri: fallback,
    });
    if (ctx.status === 202 || ctx.status === 204 || ctx.status === 200) {
      invalidate(key);
      return dev.name;
    }
  }
  throw new Error(
    reasonFrom(
      play.json,
      "Spotify had nothing to resume — set SPOTIFY_DEFAULT_CONTEXT or start once from the Spotify app",
    ),
  );
}

/**
 * Point an account's playback at a room WITHOUT necessarily starting it —
 * the hand-off step. Spotify has no deep link that pre-selects a Connect
 * device, so the app does the device selection over the API and then sends
 * the phone into the Spotify app, which opens already attached to the room.
 * That is the whole trick behind "control this room from your own Spotify".
 */
export async function transferToRoom(
  room: string,
  key: AccountKey,
  play = false,
): Promise<string> {
  const name = roomDeviceName(room);
  if (!name) throw new Error(`no Spotify endpoint mapped for ${room}`);
  const dev = await resolveDevice(room, key);
  const { status, json } = await api("PUT", "/me/player", key, { device_ids: [dev.id], play });
  if (status !== 202 && status !== 204 && status !== 200) {
    throw new Error(reasonFrom(json, `could not hand the ${room} to Spotify (HTTP ${status})`));
  }
  invalidate(key);
  return dev.name;
}
