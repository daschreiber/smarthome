import fs from "node:fs";
import path from "node:path";

/**
 * Away mode: one house-wide switch for "we're not living here right now" —
 * a couple of nights, or a few weeks. It is deliberately NOT a lockdown:
 * children and cleaners keep coming and going, every switch and app control
 * still works, nothing is deleted or individually disabled. The mode only
 * changes what runs BY ITSELF:
 *
 * - Scheduled automations PAUSE (their enabled flags untouched), except the
 *   ones explicitly marked to keep running while away (awayBehavior: "run")
 *   — that's how evening presence lighting stays on the schedule.
 * - Auto-off timers KEEP WORKING — with people passing through, a light
 *   left on is more likely, not less.
 * - Sleep sense won't arm (nobody is sleeping in the Master Bedroom), and
 *   a session it is running gets stopped when the mode turns on.
 *
 * Switching back off simply lifts the gate: automations resume at their
 * next scheduled minute — missed firings are not replayed, same as after a
 * restart.
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
  fs.writeFileSync(storePath(), JSON.stringify(st, null, 2));
  return st;
}

/**
 * Does this automation still run while the house is away? Absent means NO —
 * pausing is the default the mode exists for; running through it is the
 * marked exception (presence lighting, plant irrigation, …).
 */
export function runsWhileAway(a: { awayBehavior?: "pause" | "run" }): boolean {
  return a.awayBehavior === "run";
}
