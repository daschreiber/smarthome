import fs from "node:fs";
import path from "node:path";

/**
 * Per-user favorites, stored as a small JSON file next to the audit log.
 * File storage is deliberate for the household scale; swap for Postgres at
 * Phase D if Railway's ephemeral filesystem becomes a nuisance.
 */

type FavMap = Record<string, string[]>;

function favPath(): string {
  return process.env.FAVORITES_PATH || path.join(process.cwd(), "favorites.json");
}

function load(): FavMap {
  try {
    return JSON.parse(fs.readFileSync(favPath(), "utf8")) as FavMap;
  } catch {
    return {};
  }
}

export function getFavorites(user: string): string[] {
  return load()[user] ?? [];
}

export function toggleFavorite(user: string, deviceId: string): string[] {
  const all = load();
  const set = new Set(all[user] ?? []);
  if (set.has(deviceId)) set.delete(deviceId);
  else set.add(deviceId);
  all[user] = [...set];
  fs.writeFileSync(favPath(), JSON.stringify(all, null, 2));
  return all[user];
}
