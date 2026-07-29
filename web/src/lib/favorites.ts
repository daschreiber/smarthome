import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";

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
  return readJsonFile<FavMap>(favPath(), {});
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
  writeJsonFile(favPath(), all);
  return all[user];
}
