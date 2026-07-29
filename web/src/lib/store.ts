import fs from "node:fs";
import path from "node:path";

/**
 * Shared JSON-file persistence for the app's small stores (users, scenes,
 * automations, timers, favorites, watcher state, …). Two rules every store
 * gets for free:
 *
 * 1. A MISSING file is an empty store; a CORRUPT file is an error. The
 *    stores live on a volume — if a crash or full disk truncates one,
 *    parsing must fail loudly, not report "empty" (users.ts would then
 *    re-seed from APP_USERS and overwrite everyone's accounts).
 * 2. Writes are atomic: write a temp file, then rename over the original.
 *    A crash mid-write leaves the old file intact instead of a truncated
 *    one. The parent directory is created on demand (fresh volume mounts).
 */

export function readJsonFile<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${file} exists but is not valid JSON — refusing to treat it as empty; restore or delete it`);
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
