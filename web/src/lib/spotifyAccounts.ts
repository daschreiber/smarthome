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

export function houseRefreshToken(): string | null {
  try {
    const token = JSON.parse(fs.readFileSync(housePath(), "utf8")).refresh_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

export function saveHouseRefreshToken(refreshToken: string): void {
  writeJsonFile(housePath(), { refresh_token: refreshToken });
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
 * Save (or replace) one person's link. Re-linking an existing account is
 * always allowed — only a NEW person can hit the ceiling, and they're told
 * the number rather than a bare refusal.
 */
export function saveLink(link: Omit<UserLink, "linkedAt">): void {
  const links = loadLinks();
  const at = links.findIndex((l) => l.user.toLowerCase() === link.user.toLowerCase());
  if (at < 0 && links.length >= MAX_LINKED_USERS) {
    throw new Error(
      `Spotify allows ${MAX_LINKED_USERS} linked accounts for this app — someone has to unlink first (More → Spotify)`,
    );
  }
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
