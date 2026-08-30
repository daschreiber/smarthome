import fs from "node:fs";
import { writeJsonFile } from "./store";
import path from "node:path";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { getState } from "./ha";
import { registry, type Device } from "./registry";
import { TV_LIFT_ENTITY, liftSleepState } from "./sleepwatch";

/**
 * TV follower: the Master Bedroom TV runs in unison with its ceiling lift
 * (owner report, 2026-08-29 — the house has always worked this way).
 * Whenever the lift comes DOWN — keypad, app, or Control4 — the TV turns
 * on; whenever it goes back UP, the TV turns off. The behavior stopped
 * working some time before 2026-08-29; the old link never lived in this
 * stack (no HA automation, no app rule — it was Control4-side programming
 * we don't hold), so instead of chasing what broke inside Control4 the app
 * now owns the rule.
 *
 * A standing house rule like Sleep sense and the Sauna follower, NOT a
 * user-authored automation: the trigger is the lift relay's STATE, which
 * the step builder can't express. Evaluated on the scheduler's 30s tick.
 *
 * Deliberate semantics, same philosophy as the rest of the house:
 * - EDGES only, never levels: the follower reacts to the lift CHANGING
 *   position. Someone who turns the TV off by remote with the lift still
 *   down (or on while it's stowed) is a human making a choice — the
 *   follower never re-asserts against them.
 * - Unknown is not "up": an unreadable lift state holds the last known
 *   baseline instead of inventing an edge. Same rule after a restart: the
 *   first readable state only sets the baseline, it never acts — a deploy
 *   mid-movie must not power-cycle the TV.
 * - A failed TV command spends the edge anyway (no per-tick retry storm at
 *   the bedside); the audit row is the trail. The next lift move tries
 *   again by nature.
 *
 * Polarity rides the same knob as Sleep sense: SLEEPWATCH_LIFT_STATE names
 * the relay state that means "stowed" (default "off" — proven nightly by
 * the sleep watcher arming), and "down" is the other one. One knob, so the
 * two rules can never disagree about which way the TV went.
 */

/** The Samsung on the lift. Hidden from the room's cards since 2026-07-22
 *  (the MBR media cards were dead — that note was about the Control4
 *  zone's missing turn_on), but the entity itself advertises turn_on and
 *  turn_off (supported_features 152461). */
export const TV_ENTITY = "media_player.55_qled";

export interface LiftwatchState {
  enabled: boolean;
  /** Last KNOWN lift position (true = down); null = no baseline yet
   *  (fresh install or restart before the first readable state). */
  lastDown: boolean | null;
}

const DEFAULT_STATE: LiftwatchState = { enabled: true, lastDown: null };

function storePath(): string {
  return process.env.LIFTWATCH_PATH || path.join(process.cwd(), "liftwatch.json");
}

export function loadLiftwatch(): LiftwatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<LiftwatchState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveLiftwatch(st: LiftwatchState): void {
  writeJsonFile(storePath(), st);
}

/** The TV the lift carries, from the registry (visible:false there — the
 *  follower drives it even though the room shows no card for it). */
export function tvDevice(): Device | null {
  return registry().devices.find((d) => d.entityId === TV_ENTITY) ?? null;
}

/** The follower exists once the TV is in the entity map. */
export function liftwatchAvailable(): boolean {
  return tvDevice() !== null;
}

/** Relay state → lift position. Only the two real relay states count:
 *  unavailable/unknown (integration restart, Director unreachable) is
 *  null, never a position — a flap must not fake a movement. */
export function liftDownFromState(state: string | undefined | null): boolean | null {
  if (state !== "on" && state !== "off") return null;
  return state !== liftSleepState();
}

export type TvFollowAction = "tv_on" | "tv_off" | null;

/**
 * Pure edge detector — all I/O stays in tickLiftwatch. `down` is the
 * lift's position, or null when the relay state was unreadable.
 */
export function evaluateTvFollow(
  down: boolean | null,
  st: LiftwatchState,
): { action: TvFollowAction; next: LiftwatchState } {
  if (down === null) return { action: null, next: st }; // hold on missing data
  if (st.lastDown === null) {
    // First readable state: baseline only. A restart with the lift down
    // must not re-command a TV someone already turned off.
    return { action: null, next: { ...st, lastDown: down } };
  }
  if (down === st.lastDown) return { action: null, next: st };
  return { action: down ? "tv_on" : "tv_off", next: { ...st, lastDown: down } };
}

/** Scheduler hook — called every 30s tick. Cheap when the TV isn't in the
 *  registry or the rule is paused. */
export async function tickLiftwatch(): Promise<void> {
  if (!loadLiftwatch().enabled || !liftwatchAvailable()) return;

  let down: boolean | null = null;
  try {
    const s = await getState(TV_LIFT_ENTITY);
    down = liftDownFromState(s?.state);
  } catch {
    down = null;
  }

  // Re-read AFTER the await: a pause flipped while the HA request was in
  // flight must win — evaluating (and saving) the pre-request state would
  // silently undo the pause and command the TV on a tick the admin already
  // stopped (Codex review, 2026-08-29).
  const st = loadLiftwatch();
  if (!st.enabled) return;
  const { action, next } = evaluateTvFollow(down, st);
  // Persist the baseline BEFORE acting: a crash mid-command must not
  // replay the edge (and double-audit) on the next tick.
  if (next.lastDown !== st.lastDown) saveLiftwatch(next);
  if (!action) return;

  const dev = tvDevice()!;
  const started = Date.now();
  let error: string | undefined;
  try {
    await executeOnDevice(dev, { command: action === "tv_on" ? "turn_on" : "turn_off" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  audit({
    ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
    entityId: "liftwatch", command: action === "tv_on" ? "lift_tv_on" : "lift_tv_off",
    args: { lift: action === "tv_on" ? "down" : "up" },
    ok: !error, durationMs: Date.now() - started, error,
  });
  console.log(
    `[liftwatch] lift ${action === "tv_on" ? "down → TV on" : "up → TV off"}` +
    (error ? ` FAILED: ${error}` : ""),
  );
}
