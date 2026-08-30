import fs from "node:fs";
import { writeJsonFile } from "./store";
import path from "node:path";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { callService, getState } from "./ha";
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
 * Deliberate semantics, same philosophy as the rest of the house — but
 * ASYMMETRIC after the first field test (owner, 2026-08-30: lowering
 * turned the TV on, raising left it playing inside the ceiling through a
 * full up-and-down cycle — a single missed or failed off-edge, and edge-
 * only semantics had no second chance):
 * - The ON side is an EDGE, never a level: the TV comes on exactly once
 *   per lowering. Someone who turns it off by remote with the lift still
 *   down is a human making a choice — the follower never relights it.
 * - The OFF side is the edge PLUS bounded level enforcement: while the
 *   lift is up and the TV still reads "on", keep commanding off — up to
 *   MAX_OFF_ATTEMPTS per stow, one per tick, every attempt audited, then
 *   stand down until the lift next comes down. A TV that is ON inside the
 *   ceiling is never a human's choice, so re-asserting here fights a
 *   failure, not a person. This also covers the restart hole: a baseline
 *   re-learned with the lift already up no longer strands a playing TV.
 *   The retries ESCALATE (the KNX dimmer pattern — attempt 2+ changes the
 *   command's shape): attempt 1 is media_player.turn_off, whose short
 *   power press only blinks this Samsung's screen (field report
 *   2026-08-30); attempts 2+ send a held power key through the TV's
 *   remote entity — the press that actually powers the panel down.
 * - Unknown is not "up": an unreadable lift state holds the last known
 *   baseline instead of inventing an edge. Same rule after a restart: the
 *   first readable state only sets the baseline, it never acts — a deploy
 *   mid-movie must not power-cycle the TV. (The off-enforcement needs the
 *   TV to affirmatively read "on"; unknown TV state never triggers it.)
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
  /** turn_off attempts spent this stow (lift-up) episode; reset whenever
   *  the lift is down. Bounds the off-enforcement. */
  offAttempts?: number;
}

const DEFAULT_STATE: LiftwatchState = { enabled: true, lastDown: null };

/** Off commands per stow episode: the up-edge spends the first, and the
 *  enforcement spends the rest while the TV still reads "on". Enough to
 *  out-stubborn a dropped network command, small enough that a truly
 *  unreachable TV gets three audit rows, not a nightly war. */
export const MAX_OFF_ATTEMPTS = 3;

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

/** The TV's remote entity (same samsungtv integration), for the escalated
 *  off. Empty LIFTWATCH_TV_REMOTE disables escalation entirely. */
export function tvRemoteEntity(): string {
  return process.env.LIFTWATCH_TV_REMOTE ?? "remote.55_qled";
}

/** The key the escalated off sends. Samsung's short KEY_POWER press is a
 *  toggle-ish blink on the QLED family (field report 2026-08-30: screen
 *  flashes, stays on); a HELD power press is the full power-off. If this
 *  model wants the discrete key instead, set LIFTWATCH_OFF_KEY=KEY_POWEROFF. */
export function offKey(): string {
  return process.env.LIFTWATCH_OFF_KEY || "KEY_POWER";
}

/** Seconds the escalated off holds the key (0 = plain press). */
export function offHoldSecs(): number {
  const raw = Number(process.env.LIFTWATCH_OFF_HOLD_SECS);
  const s = Number.isFinite(raw) ? raw : 3;
  return Math.min(10, Math.max(0, s));
}

/** TV power from the media_player's state. Anything a powered TV reports
 *  counts as on; "off"/"standby" is off; unavailable/unknown is null —
 *  the enforcement only ever acts on an affirmative "on". */
export function tvOnFromState(state: string | undefined | null): boolean | null {
  if (state == null) return null;
  if (["on", "playing", "paused", "idle", "buffering"].includes(state)) return true;
  if (state === "off" || state === "standby") return false;
  return null;
}

export type TvFollowAction = "tv_on" | "tv_off" | null;

/**
 * Pure decision function — all I/O stays in tickLiftwatch. `down` is the
 * lift's position and `tvOn` the TV's power, each null when unreadable.
 */
export function evaluateTvFollow(
  down: boolean | null,
  tvOn: boolean | null,
  st: LiftwatchState,
): { action: TvFollowAction; next: LiftwatchState } {
  if (down === null) return { action: null, next: st }; // hold on missing data
  if (st.lastDown === null) {
    // First readable state: baseline only, never an action. With the lift
    // down that protects a TV someone already turned off; with it up, a
    // stranded-on TV is caught by the enforcement on the NEXT tick — one
    // readable lift state as baseline keeps a flapping relay from acting.
    return { action: null, next: { ...st, lastDown: down, offAttempts: 0 } };
  }
  if (down) {
    // Down: the up→down edge turns the TV on, once; a new stow episode
    // gets a fresh attempt budget.
    return {
      action: st.lastDown ? null : "tv_on",
      next: { ...st, lastDown: true, offAttempts: 0 },
    };
  }
  // Up: the down→up edge spends the first off attempt; while the TV still
  // affirmatively reads "on" (never on unknown), the enforcement spends
  // the rest — a TV inside the ceiling is never meant to be on.
  const attempts = st.offAttempts ?? 0;
  if (st.lastDown || (tvOn === true && attempts < MAX_OFF_ATTEMPTS)) {
    return {
      action: "tv_off",
      next: { ...st, lastDown: false, offAttempts: attempts + 1 },
    };
  }
  return { action: null, next: { ...st, lastDown: false } };
}

/** Scheduler hook — called every 30s tick. Cheap when the TV isn't in the
 *  registry or the rule is paused. */
export async function tickLiftwatch(): Promise<void> {
  if (!loadLiftwatch().enabled || !liftwatchAvailable()) return;

  // Each read fails alone: a TV briefly unreachable must not blind the
  // lift edge, and vice versa.
  const [liftRes, tvRes] = await Promise.allSettled([
    getState(TV_LIFT_ENTITY),
    getState(TV_ENTITY),
  ]);
  const down =
    liftRes.status === "fulfilled" ? liftDownFromState(liftRes.value?.state) : null;
  const tvOn = tvRes.status === "fulfilled" ? tvOnFromState(tvRes.value?.state) : null;

  // Re-read AFTER the awaits: a pause flipped while the HA requests were
  // in flight must win — evaluating (and saving) the pre-request state
  // would silently undo the pause and command the TV on a tick the admin
  // already stopped (Codex review, 2026-08-29).
  const st = loadLiftwatch();
  if (!st.enabled) return;
  const { action, next } = evaluateTvFollow(down, tvOn, st);
  // Persist the baseline AND the spent attempt BEFORE acting: a crash
  // mid-command must not replay the edge (and double-audit) on the next
  // tick, and the attempt budget must burn down even through crashes.
  if (JSON.stringify(next) !== JSON.stringify(st)) saveLiftwatch(next);
  if (!action) return;

  const attempt = next.offAttempts ?? 0;
  const dev = tvDevice()!;
  const started = Date.now();
  let error: string | undefined;
  let method = "media_player";
  try {
    if (action === "tv_on") {
      await executeOnDevice(dev, { command: "turn_on" });
    } else {
      // Attempt 1 is the integration's own turn_off. If the TV still reads
      // on a tick later, the command shape ESCALATES — same pattern as the
      // KNX dimmer retries (attempt 2+ names brightness_pct): a held
      // power-key press through the TV's remote entity, which is what
      // fully powers this Samsung down where the short press only blinks
      // the screen (field report 2026-08-30). A fixed, code-owned service
      // call, not a passthrough; skipped when the remote entity is absent
      // (older HA) or LIFTWATCH_TV_REMOTE is emptied.
      const remote = attempt >= 2 ? tvRemoteEntity() : "";
      const remoteUsable =
        remote !== "" && (await getState(remote).catch(() => null)) !== null;
      // The probe is one more awaited request: a pause flipped while it
      // was in flight must win here too, same as after the state polls
      // (Codex review, 2026-08-30).
      if (remote !== "" && !loadLiftwatch().enabled) return;
      if (remoteUsable) {
        method = "remote_hold";
        const data: Record<string, unknown> = { entity_id: remote, command: offKey() };
        if (offHoldSecs() > 0) data.hold_secs = offHoldSecs();
        await callService("remote", "send_command", data);
      } else {
        await executeOnDevice(dev, { command: "turn_off" });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  audit({
    ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
    entityId: "liftwatch", command: action === "tv_on" ? "lift_tv_on" : "lift_tv_off",
    args: action === "tv_on" ? { lift: "down" } : { lift: "up", attempt, method },
    ok: !error, durationMs: Date.now() - started, error,
  });
  console.log(
    `[liftwatch] lift ${action === "tv_on" ? "down → TV on" : `up → TV off (attempt ${attempt}/${MAX_OFF_ATTEMPTS}, ${method})`}` +
    (error ? ` FAILED: ${error}` : ""),
  );
}
