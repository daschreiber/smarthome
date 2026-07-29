import fs from "node:fs";
import { writeJsonFile } from "./store";
import path from "node:path";

/**
 * Away mode: one house-wide switch for "we're not living here right now" —
 * a couple of nights, or a few weeks. It is deliberately NOT a lockdown:
 * children and cleaners keep coming and going, every switch and app control
 * still works, nothing is deleted or individually disabled.
 *
 * What it changes (owner-revised 2026-07-25 — away no longer stops
 * everything): each automation carries an activeWhen mode —
 *
 * - "always" (the DEFAULT): runs at home and away alike. Flipping Away
 *   changes nothing for it.
 * - "home":   runs only while someone's living here — the "no point when
 *   we're gone" schedules. Paused while away.
 * - "away":   runs only while the house is empty — presence lighting,
 *   security-ish routines. Paused while home.
 *
 * Auto-off timers KEEP WORKING regardless (with people passing through, a
 * light left on is more likely, not less), and Sleep sense stands down
 * while away (nobody is sleeping in the Master Bedroom).
 *
 * Flipping back simply moves the gate: automations resume at their next
 * scheduled minute — missed firings are not replayed, same as after a
 * restart. The switch lives on the Home screen and the Automations screen.
 */

export interface AwayState {
  away: boolean;
  /** When the mode was last flipped (either direction). */
  since?: string;
  setBy?: string;
}

const DEFAULT_STATE: AwayState = { away: false };

function storePath(): string {
  return process.env.AWAY_PATH || path.join(process.cwd(), "away.json");
}

export function loadAway(): AwayState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<AwayState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function isAway(): boolean {
  return loadAway().away;
}

export function setAway(away: boolean, user: string): AwayState {
  const st: AwayState = { away, since: new Date().toISOString(), setBy: user };
  writeJsonFile(storePath(), st);
  return st;
}

/** When an automation is active: always (default), home-only, or away-only. */
export type ActiveWhen = "always" | "home" | "away";

export const ACTIVE_WHEN_VALUES: ActiveWhen[] = ["always", "home", "away"];

/**
 * Should this automation run right now, given the house's away state?
 * Absent means "always" — an automation nobody has thought about must keep
 * working exactly as it always has, whatever the switch says.
 */
export function automationActiveNow(
  a: { activeWhen?: ActiveWhen },
  away: boolean,
): boolean {
  const mode = a.activeWhen ?? "always";
  if (mode === "always") return true;
  return away ? mode === "away" : mode === "home";
}
