import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { registry, type Device } from "./registry";
import { saunaConfigured, saunaStatus } from "./sauna";

/**
 * Sauna follower: the Sauna room's A/C runs in unison with the sauna
 * (owner request, 2026-07-26). Whenever the sauna turns ON — from the app,
 * the Saturday automation, or the KLAFS panel — the room's A/C goes on at
 * a fixed set-point; whenever the sauna turns OFF (including the sauna
 * app's own auto-stop watchdog), the A/C turns off.
 *
 * A standing house rule like Sleep sense, NOT a user-authored automation:
 * the trigger is the sauna's STATE, which the step builder can't express.
 * Evaluated on the scheduler's 30s tick.
 *
 * Deliberate semantics, same philosophy as the rest of the house:
 * - EDGES only, never levels: the follower reacts to the sauna CHANGING
 *   power state. Someone who turns the A/C off mid-session (or on while
 *   the sauna is cold) is a human making a choice — the follower never
 *   re-asserts against them.
 * - Unknown is not "off": a failed status read, or the sauna reporting
 *   disconnected from KLAFS, holds the last known state instead of
 *   inventing an edge. Same rule after a restart: the first readable
 *   status only sets the baseline, it never acts.
 * - The A/C target is SAUNA_AC_TEMP °C (default 20, clamped to the room
 *   climate bounds 10-32).
 */

export interface SaunawatchState {
  enabled: boolean;
  /** Last KNOWN sauna power state; null = no baseline yet (fresh install
   *  or restart before the first readable status). */
  lastPower: boolean | null;
}

const DEFAULT_STATE: SaunawatchState = { enabled: true, lastPower: null };

function storePath(): string {
  return process.env.SAUNAWATCH_PATH || path.join(process.cwd(), "saunawatch.json");
}

export function loadSaunawatch(): SaunawatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<SaunawatchState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveSaunawatch(st: SaunawatchState): void {
  fs.writeFileSync(storePath(), JSON.stringify(st, null, 2));
}

/** The Sauna room's A/C zone(s), derived from the registry — a renamed or
 *  added zone joins the rule automatically. */
export function saunaAcDevices(): Device[] {
  return registry().devices.filter(
    (d) => d.room === "Sauna" && d.kind === "climate" && d.visible,
  );
}

export function saunaAcTemp(): number {
  const raw = Number(process.env.SAUNA_AC_TEMP);
  const t = Number.isFinite(raw) ? raw : 20;
  return Math.min(32, Math.max(10, t));
}

/** The follower exists once the sauna is configured and the room has A/C. */
export function saunawatchAvailable(): boolean {
  return saunaConfigured() && saunaAcDevices().length > 0;
}

export type SaunaFollowAction = "ac_on" | "ac_off" | null;

/**
 * Pure edge detector — all I/O stays in tickSaunawatch. `power` is the
 * sauna's power state, or null when the status was unreadable (failed
 * fetch, or disconnected from KLAFS — a stale reading must not fake an
 * edge).
 */
export function evaluateSaunaFollow(
  power: boolean | null,
  st: SaunawatchState,
): { action: SaunaFollowAction; next: SaunawatchState } {
  if (power === null) return { action: null, next: st }; // hold on missing data
  if (st.lastPower === null) {
    // First readable status: baseline only. A restart mid-session must not
    // re-command an A/C someone already adjusted.
    return { action: null, next: { ...st, lastPower: power } };
  }
  if (power === st.lastPower) return { action: null, next: st };
  return { action: power ? "ac_on" : "ac_off", next: { ...st, lastPower: power } };
}

/** Scheduler hook — called every 30s tick. Cheap when the sauna app or the
 *  room A/C isn't configured. */
export async function tickSaunawatch(): Promise<void> {
  const st = loadSaunawatch();
  if (!st.enabled || !saunawatchAvailable()) return;

  let power: boolean | null = null;
  try {
    const s = await saunaStatus();
    // Disconnected-from-KLAFS readings are stale, not evidence.
    power = s.connected ? s.poweredOn : null;
  } catch {
    power = null;
  }

  const { action, next } = evaluateSaunaFollow(power, st);
  // Persist the baseline BEFORE acting: a crash mid-command must not
  // replay the edge (and double-audit) on the next tick.
  if (next.lastPower !== st.lastPower) saveSaunawatch(next);
  if (!action) return;

  const temp = saunaAcTemp();
  const started = Date.now();
  const failures: string[] = [];
  for (const dev of saunaAcDevices()) {
    try {
      if (action === "ac_on") {
        await executeOnDevice(dev, { command: "turn_on" });
        await executeOnDevice(dev, { command: "set_temperature", temperature: temp });
      } else {
        await executeOnDevice(dev, { command: "turn_off" });
      }
    } catch (err) {
      failures.push(`${dev.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  audit({
    ts: new Date().toISOString(), user: "saunawatch", deviceId: "automations",
    entityId: "saunawatch", command: action === "ac_on" ? "sauna_ac_on" : "sauna_ac_off",
    args: action === "ac_on" ? { temperature: temp } : {},
    ok: failures.length === 0, durationMs: Date.now() - started,
    error: failures.length ? failures.join("; ") : undefined,
  });
  console.log(
    `[saunawatch] sauna ${action === "ac_on" ? "on → A/C on at " + temp + "°" : "off → A/C off"}` +
    (failures.length ? ` with ${failures.length} failure(s)` : ""),
  );
}
