import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";

/**
 * Which Spotify account the app plays as. There are two kinds:
 *
 * - HOUSE — the single account an admin links once. It stays the fallback
 *   for anyone who hasn't linked their own (and for the APP_KEY admin), so
 *   room Play never stops working. Its refresh token keeps the original
 *   file and shape (SPOTIFY_TOKEN_PATH, `{refresh_token}`) so the deployed
 *   volume needs no migration.
 * - USER — a household member's own Spotify, linked by that person from
 *   More. Their phone's Play/Pause/Skip then drive THEIR account. This is
 *   the point of the whole feature: Spotify allows one playback session per
 *   ACCOUNT, so one account can never play different music in two rooms —
 *   but two accounts can. Ruth's music in the Kitchen no longer yanks
 *   Daniel's out of the Lounge.
 *
 * Spotify's Development Mode (the tier a private household app lives in)
 * allows five authorised users per Client ID since February 2026 — down
 * from twenty-five. That ceiling is enforced here so the app can say so up
 * front instead of letting someone fail at Spotify's consent screen. The
 * house account consumes one of those five whenever it is a different
 * Spotify user from everyone who links personally.
 */

/** Spotify Development Mode: authorised users per Client ID (Feb 2026). */
export const MAX_LINKED_USERS = 5;

export interface UserLink {
  /** The app account (email) this Spotify login belongs to. */
  user: string;
  refreshToken: string;
  /** From Spotify's /me at link time — shown as "Ruth's Spotify". */
  displayName: string | null;
  /** Connect control is Premium-only; false lets the UI say why. */
  premium: boolean | null;
  /** The Spotify user id. Capacity is counted in Spotify USERS, not links —
   * see usedSlots(). Absent on links made before this was recorded. */
  spotifyUserId?: string | null;
  linkedAt: string;
}

/** An account the app can act as. `key` is the cache/lookup identity. */
export type AccountKey = string; // "house" | "user:<email>"

export const HOUSE: AccountKey = "house";

export function userKey(email: string): AccountKey {
  return `user:${email.toLowerCase()}`;
}

function housePath(): string {
  return process.env.SPOTIFY_TOKEN_PATH || path.join(process.cwd(), "spotify_token.json");
}

function linksPath(): string {
  return process.env.SPOTIFY_LINKS_PATH || path.join(process.cwd(), "spotify_links.json");
}

// ---- House account ----

function houseFile(): { refresh_token?: unknown; spotify_user_id?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(housePath(), "utf8"));
  } catch {
    return {};
  }
}

export function houseRefreshToken(): string | null {
  const token = houseFile().refresh_token;
  return typeof token === "string" && token ? token : null;
}

/** Null for a house account linked before ids were recorded — usedSlots()
 *  treats that as "an identity we can't match", not "no identity". */
export function houseSpotifyUserId(): string | null {
  const id = houseFile().spotify_user_id;
  return typeof id === "string" && id ? id : null;
}

/**
 * The house file keeps its original `{refresh_token}` shape plus an
 * optional id, so a volume written by the previous build still reads. A
 * token rotation carries the known id forward rather than dropping it.
 */
export function saveHouseRefreshToken(refreshToken: string, spotifyUserId?: string | null): void {
  const id = spotifyUserId ?? houseSpotifyUserId();
  writeJsonFile(housePath(), { refresh_token: refreshToken, ...(id ? { spotify_user_id: id } : {}) });
}

// ---- Per-user links ----

function loadLinks(): UserLink[] {
  return readJsonFile<UserLink[]>(linksPath(), []);
}

export function listLinks(): UserLink[] {
  return loadLinks();
}

export function getLink(email: string): UserLink | null {
  const want = email.toLowerCase();
  return loadLinks().find((l) => l.user.toLowerCase() === want) ?? null;
}

/**
 * How many of Spotify's authorised-user slots are taken, EXCLUDING one app
 * account if named.
 *
 * Spotify's allow-list counts distinct Spotify USERS, not links in our
 * store, and two things follow. The house account occupies a slot of its
 * own whenever it is a different Spotify user — so counting only personal
 * links would advertise a free slot that Spotify would refuse. But the
 * house account is usually the admin's OWN Spotify, and then their personal
 * link is the same user and costs nothing extra — so naively reserving a
 * slot for the house would wrongly turn them away.
 *
 * Hence identity, not arithmetic. An account whose Spotify id we never
 * recorded (a house link from before this was tracked) can't be matched
 * against anything, so it counts as its own slot: over-counting risks a
 * "free a slot first" message, under-counting risks a dead end at Spotify's
 * consent screen, and the first is the kinder failure.
 */
export function usedSlots(excludeUser?: string): number {
  const ids = new Set<string>();
  let unidentified = 0;
  const add = (id: string | null | undefined) => {
    if (id) ids.add(id);
    else unidentified += 1;
  };
  if (houseRefreshToken()) add(houseSpotifyUserId());
  for (const l of loadLinks()) {
    if (excludeUser && l.user.toLowerCase() === excludeUser.toLowerCase()) continue;
    add(l.spotifyUserId);
  }
  return ids.size + unidentified;
}

/** Is there room for `spotifyUserId` to link as `user`? A Spotify account
 *  already authorised (typically the house account being linked personally
 *  by the same admin) is free — it's one user to Spotify either way. */
export function hasSlotFor(user: string, spotifyUserId?: string | null): boolean {
  if (spotifyUserId) {
    const ids = new Set<string>();
    if (houseRefreshToken() && houseSpotifyUserId()) ids.add(houseSpotifyUserId()!);
    for (const l of loadLinks()) {
      if (l.user.toLowerCase() === user.toLowerCase()) continue;
      if (l.spotifyUserId) ids.add(l.spotifyUserId);
    }
    if (ids.has(spotifyUserId)) return true;
  }
  return usedSlots(user) < MAX_LINKED_USERS;
}

/**
 * Save (or replace) one person's link. Re-linking an account that already
 * holds a slot is always allowed — only a new Spotify USER can hit the
 * ceiling, and they're told the number rather than given a bare refusal.
 */
export function saveLink(link: Omit<UserLink, "linkedAt">): void {
  if (!hasSlotFor(link.user, link.spotifyUserId)) {
    throw new Error(
      `Spotify allows ${MAX_LINKED_USERS} accounts for this app — someone has to unlink first (More → Spotify)`,
    );
  }
  const links = loadLinks();
  const at = links.findIndex((l) => l.user.toLowerCase() === link.user.toLowerCase());
  const record: UserLink = { ...link, user: link.user.toLowerCase(), linkedAt: new Date().toISOString() };
  if (at < 0) links.push(record);
  else links[at] = record;
  writeJsonFile(linksPath(), links);
}

export function removeLink(email: string): boolean {
  const links = loadLinks();
  const rest = links.filter((l) => l.user.toLowerCase() !== email.toLowerCase());
  if (rest.length === links.length) return false;
  writeJsonFile(linksPath(), rest);
  return true;
}

/**
 * The account a given signed-in user plays as: their own if they've linked
 * one, otherwise the house account. Returns null when neither exists —
 * callers turn that into "Spotify isn't linked yet", never a crash.
 */
export function accountFor(email: string | null): AccountKey | null {
  if (email && getLink(email)) return userKey(email);
  return houseRefreshToken() ? HOUSE : null;
}

/** The refresh token behind an account key, or null if it's gone. */
export function refreshTokenFor(key: AccountKey): string | null {
  if (key === HOUSE) return houseRefreshToken();
  const email = key.startsWith("user:") ? key.slice(5) : null;
  return email ? getLink(email)?.refreshToken ?? null : null;
}

/** Persist a rotated refresh token in whichever store the account lives in. */
export function updateRefreshToken(key: AccountKey, refreshToken: string): void {
  if (key === HOUSE) {
    saveHouseRefreshToken(refreshToken);
    return;
  }
  const email = key.startsWith("user:") ? key.slice(5) : null;
  const existing = email ? getLink(email) : null;
  if (existing) saveLink({ ...existing, refreshToken });
}

/** Human label for an account — "Ruth's Spotify" / "the house Spotify". */
export function accountLabel(key: AccountKey): string {
  if (key === HOUSE) return "the house Spotify";
  const email = key.startsWith("user:") ? key.slice(5) : null;
  const name = email ? getLink(email)?.displayName : null;
  return name ? `${name}'s Spotify` : `${email ?? "someone"}'s Spotify`;
}

/** Every account the app can currently see a session on. */
export function allAccounts(): AccountKey[] {
  const keys: AccountKey[] = [];
  if (houseRefreshToken()) keys.push(HOUSE);
  for (const l of loadLinks()) keys.push(userKey(l.user));
  return keys;
}
