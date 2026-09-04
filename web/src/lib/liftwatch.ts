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
 * WHAT THE FIELD TESTS TAUGHT (2026-08-30, three rounds):
 * - Samsung-direct `media_player.turn_off` reaches the TV (the screen
 *   flashes) but the panel comes back on. A held power press through the
 *   TV's remote entity (#105) didn't help either — and the lift itself
 *   oscillated for minutes on the next opening. Nothing here commands the
 *   lift relay, so that oscillation is Control4 reacting to TV power
 *   events with its own residual TV↔lift programming. Conclusion:
 *   CONTROL4 STILL OWNS THE TV'S POWER IN THAT ROOM. Poking the Samsung
 *   over the network fights it; the historical off was Control4's own
 *   "Room Off", which powers the room's endpoints down through their
 *   drivers and leaves the room state consistent.
 * - So the OFF now goes through the Control4 zone (`media_player.
 *   master_bedroom`, `turn_off` = Room Off) — LIFTWATCH_OFF_ENTITY
 *   overrides, e.g. back to the Samsung entity. The ON stays the Samsung
 *   `turn_on` (network wake), which has worked every time.
 *
 * Deliberate semantics, same philosophy as the rest of the house:
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
 * - A CIRCUIT BREAKER: if the lift relay changes position BREAKER_EDGES
 *   times inside BREAKER_WINDOW_MS, something is fighting (the 2026-08-30
 *   oscillation) and the follower must not be a link in that loop — it
 *   stops commanding for BREAKER_COOLDOWN_MS, audits the trip once, and
 *   keeps only tracking the baseline. A human never moves a ceiling lift
 *   six times in five minutes.
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
 *  turn_off (supported_features 152461). It is the TV-power TRUTH (does
 *  the panel read on?) and the ON command's target. */
export const TV_ENTITY = "media_player.55_qled";

/** The Control4 zone for the room: `turn_off` is Control4's Room Off —
 *  the way the house's original lift programming powered the TV down. */
export const C4_ROOM_ENTITY = "media_player.master_bedroom";

export interface LiftwatchState {
  enabled: boolean;
  /** Last KNOWN lift position (true = down); null = no baseline yet
   *  (fresh install or restart before the first readable state). */
  lastDown: boolean | null;
  /** turn_off attempts spent this stow (lift-up) episode; reset whenever
   *  the lift is down. Bounds the off-enforcement. */
  offAttempts?: number;
  /** Recent lift edges (ms epoch), pruned to BREAKER_WINDOW_MS — the
   *  breaker's evidence. */
  edges?: number[];
  /** While now < this (ms epoch) the breaker is open: no commands. */
  breakerUntil?: number;
}

const DEFAULT_STATE: LiftwatchState = { enabled: true, lastDown: null };

/** Off commands per stow episode: the up-edge spends the first, and the
 *  enforcement spends the rest while the TV still reads "on". Enough to
 *  out-stubborn a dropped command, small enough that a truly unreachable
 *  TV gets three audit rows, not a nightly war. */
export const MAX_OFF_ATTEMPTS = 3;

/** Lift edges inside the window that mean "something is fighting". A
 *  human testing open/close twice is four; the 2026-08-30 oscillation
 *  was dozens. */
export const BREAKER_EDGES = 6;
export const BREAKER_WINDOW_MS = 5 * 60_000;
export const BREAKER_COOLDOWN_MS = 10 * 60_000;

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

/** Where the OFF goes: the Control4 room by default (Room Off), or
 *  whatever LIFTWATCH_OFF_ENTITY names — the Samsung entity to go back to
 *  network power-off. Falls back to the TV itself if the named entity
 *  isn't in the map. */
export function offEntity(): string {
  return process.env.LIFTWATCH_OFF_ENTITY || C4_ROOM_ENTITY;
}

export function offDevice(): Device | null {
  const id = offEntity();
  return registry().devices.find((d) => d.entityId === id) ?? tvDevice();
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

/** TV power from the media_player's state. Anything a powered TV reports
 *  counts as on; "off"/"standby" is off; unavailable/unknown is null —
 *  the enforcement only ever acts on an affirmative "on". */
export function tvOnFromState(state: string | undefined | null): boolean | null {
  if (state == null) return null;
  if (["on", "playing", "paused", "idle", "buffering"].includes(state)) return true;
  if (state === "off" || state === "standby") return false;
  return null;
}

export type TvFollowAction = "tv_on" | "tv_off" | "breaker_trip" | null;

/**
 * Pure decision function — all I/O stays in tickLiftwatch. `down` is the
 * lift's position and `tvOn` the TV's power, each null when unreadable.
 * "breaker_trip" is not a command: it's the one audited moment the
 * follower takes itself out of a fight.
 */
export function evaluateTvFollow(
  down: boolean | null,
  tvOn: boolean | null,
  st: LiftwatchState,
  nowMs: number = Date.now(),
): { action: TvFollowAction; next: LiftwatchState } {
  if (down === null) return { action: null, next: st }; // hold on missing data
  if (st.lastDown === null) {
    // First readable state: baseline only, never an action. With the lift
    // down that protects a TV someone already turned off; with it up, a
    // stranded-on TV is caught by the enforcement on the NEXT tick — one
    // readable lift state as baseline keeps a flapping relay from acting.
    return { action: null, next: { ...st, lastDown: down, offAttempts: 0 } };
  }

  const edge = down !== st.lastDown;
  let edges = (st.edges ?? []).filter((t) => nowMs - t < BREAKER_WINDOW_MS);
  if (edge) edges = [...edges, nowMs].slice(-BREAKER_EDGES);
  const tracked: LiftwatchState = {
    ...st,
    lastDown: down,
    edges,
    // A lowering starts a fresh stow budget either way.
    ...(down ? { offAttempts: 0 } : {}),
  };

  // Breaker open: track, never command. It closes by time alone.
  if (st.breakerUntil !== undefined && nowMs < st.breakerUntil) {
    return { action: null, next: tracked };
  }
  // Trip on the edge that completes the pattern — and only on an edge, so
  // a tripped breaker is audited exactly once.
  if (edge && edges.length >= BREAKER_EDGES) {
    return {
      action: "breaker_trip",
      next: { ...tracked, breakerUntil: nowMs + BREAKER_COOLDOWN_MS },
    };
  }

  if (down) {
    // Down: the up→down edge turns the TV on, once.
    return { action: edge ? "tv_on" : null, next: tracked };
  }
  // Up: the down→up edge spends the first off attempt; while the TV still
  // affirmatively reads "on" (never on unknown), the enforcement spends
  // the rest — a TV inside the ceiling is never meant to be on.
  const attempts = st.offAttempts ?? 0;
  if (edge || (tvOn === true && attempts < MAX_OFF_ATTEMPTS)) {
    return { action: "tv_off", next: { ...tracked, offAttempts: attempts + 1 } };
  }
  return { action: null, next: tracked };
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

  if (action === "breaker_trip") {
    audit({
      ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
      entityId: "liftwatch", command: "lift_breaker_trip",
      args: { edges: next.edges?.length ?? 0, windowMinutes: BREAKER_WINDOW_MS / 60_000, cooldownMinutes: BREAKER_COOLDOWN_MS / 60_000 },
      ok: true, durationMs: 0,
    });
    console.error(
      `[liftwatch] BREAKER: lift moved ${next.edges?.length} times in ${BREAKER_WINDOW_MS / 60_000} min — standing down for ${BREAKER_COOLDOWN_MS / 60_000} min`,
    );
    return;
  }

  const attempt = next.offAttempts ?? 0;
  const dev = action === "tv_on" ? tvDevice()! : offDevice()!;
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
    args: action === "tv_on" ? { lift: "down", via: dev.entityId } : { lift: "up", attempt, via: dev.entityId },
    ok: !error, durationMs: Date.now() - started, error,
  });
  console.log(
    `[liftwatch] lift ${action === "tv_on" ? "down → TV on" : `up → TV off (attempt ${attempt}/${MAX_OFF_ATTEMPTS})`} via ${dev.entityId}` +
    (error ? ` FAILED: ${error}` : ""),
  );
}
