import fs from "node:fs";
import { writeJsonFile } from "./store";
import path from "node:path";
import { nowParts } from "./automations";
import { isAway } from "./away";
import { audit } from "./audit";
import { getStates } from "./ha";
import { registry } from "./registry";
import { noiseConfigured, noiseStatusFresh, noiseTurnOff, noiseTurnOn } from "./whitenoise";

/**
 * Sleep watcher: condition-triggered white noise for the Master Bedroom.
 *
 * The rooms's state IS the trigger — no button pressed, no time picked.
 * Between 22:00 and 08:00, when the room "looks like bedtime" — every light
 * off (the two bedside reading lights and the two closet lights are allowed
 * on) and the TV lift stowed — the noise starts. There is NO morning clock: the noise stops
 * when the room wakes — a watched light comes on, or a shade visibly moves
 * toward open — however late (or early) that is. Evaluated by the
 * in-process scheduler on its 30s tick; a small JSON file carries state
 * across restarts.
 *
 * Shades are deliberately NOT an arming condition (learned the hard way on
 * 2026-07-22's first real night): the Control4 covers' position feedback is
 * stuck near 1%, so the entities report "open" forever — even shut tight.
 * "All shades closed" could never be true and the watcher never armed. A
 * condition that reality can't satisfy isn't a condition, it's an off
 * switch. For STOPPING, the same brokenness dictates an EDGE, not a level:
 * "any shade open" would be true every second of every night, but "a
 * shade's reported state/position CHANGED toward open since the last tick"
 * only fires on movement the integration actually reports. While the
 * feedback stays frozen this trigger is simply inert — lights remain the
 * working wake signal — and it starts working the day the feedback is
 * fixed, with no code change.
 *
 * Deliberate semantics, so the watcher never fights a human:
 * - If noise is already playing when conditions are met, the watcher ADOPTS
 *   it (so the wake-up stop applies to it) rather than re-commanding.
 * - If the watcher started the noise and someone turns it off (bedside
 *   remote, the app) while the room still looks asleep, it LATCHES off for
 *   the night instead of re-firing 30s later. The latch clears when a
 *   cancel condition appears — a light on / a shade opening resets the
 *   night, and the next fully-met bedtime arms fresh.
 * - EXCEPT within the first 3 minutes of a watcher-started stream: the
 *   same night the shades bug surfaced, the Control4 goodnight sweep
 *   turned the Yamaha off twice ~40s after the stream started. A death
 *   that early is interference, not intent — retry (twice, then latch).
 * - The TV lift going down does NOT stop the noise (it only gates arming):
 *   late-night TV with noise running is the couple's call, not ours.
 *
 * Eight Sleep presence is deliberately NOT an input here (owner's call,
 * 2026-07-25, and the first field test agreed: presence read "bed empty"
 * for 4½ minutes with someone lying in it). The watcher runs on lights and
 * the TV lift only; bed presence is display-only on the bed cards.
 */

export const SLEEP_ROOM = "Master Bedroom";
// The window gates ARMING only — a session in flight runs until the room
// wakes (light on / shade opening), never until a clock.
export const WINDOW_START = "22:00"; // inclusive
export const WINDOW_END = "08:00"; // exclusive

/** Bedside reading lights: allowed on at bedtime, and turning one on at
 *  3am doesn't kill the noise either — the exemption is symmetric. */
export const READING_LIGHTS = new Set([
  "light.knx_switch_master_bedroom_read_left",
  "light.knx_switch_master_bedroom_read_right",
]);

/** Closet lights: same symmetric exemption as the reading pair (owner,
 *  2026-07-24) — being on never blocks arming, coming on never wakes. */
export const CLOSET_LIGHTS = new Set([
  "light.knx_switch_master_bedroom_closets_lightstrip",
  "light.knx_switch_master_bedroom_closets_strip",
]);

export const TV_LIFT_ENTITY = "light.knx_switch_mbr_tv_lift";
/** Relay state that means "lift stowed for sleep" ("up" per the household).
 *  If the polarity turns out inverted, set SLEEPWATCH_LIFT_STATE=on. */
export function liftSleepState(): string {
  return process.env.SLEEPWATCH_LIFT_STATE || "off";
}

/** A cover's last-seen report, for movement (edge) detection. */
export interface CoverSnap {
  s: string;
  p: number | null;
}

export interface SleepwatchState {
  enabled: boolean;
  /** The watcher started (or adopted) the currently-playing noise. */
  active: boolean;
  /** Fired-and-manually-stopped this bedtime episode; don't re-fire. */
  latched: boolean;
  /** When the watcher last STARTED the stream (ms epoch); null if adopted.
   *  Grounds the early-death retry window. */
  startedAtMs?: number | null;
  /** Early-death retries used this episode. */
  retries?: number;
  /** Last-seen cover state/position per MBR shade — the baseline the
   *  "shade opened" edge is detected against. */
  coverSnap?: Record<string, CoverSnap>;
}

const DEFAULT_STATE: SleepwatchState = { enabled: true, active: false, latched: false };

/** A watcher-started stream dying this soon is interference (the C4
 *  goodnight sweep), not a human choice. */
export const RETRY_WINDOW_MS = 3 * 60_000;
export const MAX_RETRIES = 2;

function storePath(): string {
  return process.env.SLEEPWATCH_PATH || path.join(process.cwd(), "sleepwatch.json");
}

export function loadSleepwatch(): SleepwatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<SleepwatchState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveSleepwatch(st: SleepwatchState): void {
  writeJsonFile(storePath(), st);
}

export function inWindow(hhmm: string): boolean {
  // The window crosses midnight, so it's an OR, not a range.
  return hhmm >= WINDOW_START || hhmm < WINDOW_END;
}

/** The lights whose being ON means "not asleep": every visible real light in
 *  the room except the bedside reading pair and the closet pair. Derived
 *  from the registry so a future light joins the watch automatically. */
export function watchedLightEntities(): string[] {
  return registry()
    .devices.filter(
      (d) =>
        d.room === SLEEP_ROOM &&
        d.kind === "light" &&
        d.visible &&
        d.group === "Lighting" &&
        d.category !== "scene_switch" &&
        !READING_LIGHTS.has(d.entityId) &&
        !CLOSET_LIGHTS.has(d.entityId),
    )
    .map((d) => d.entityId);
}

/** The room's shades, watched for opening MOVEMENT (never absolute state —
 *  see the header). Derived from the registry like the lights. */
export function coverEntities(): string[] {
  return registry()
    .devices.filter((d) => d.room === SLEEP_ROOM && d.kind === "cover" && d.visible)
    .map((d) => d.entityId);
}

/** Position must move at least this much toward open to count as movement —
 *  the C4 feedback jitters near 1% and jitter is not a wake-up. */
const OPEN_DELTA = 3;

/** True when a cover's report moved toward OPEN since the last snapshot.
 *  Conservative on purpose: unavailable→open flapping (integration restart)
 *  is not movement; only closed/closing→open/opening or a numeric position
 *  increase counts. */
function movedOpen(prev: CoverSnap | undefined, cur: CoverSnap): boolean {
  if (!prev) return false;
  const stateOpened =
    (prev.s === "closed" || prev.s === "closing") && (cur.s === "open" || cur.s === "opening");
  const posOpened = prev.p != null && cur.p != null && cur.p >= prev.p + OPEN_DELTA;
  return stateOpened || posOpened;
}

export type SleepwatchAction = "start" | "stop" | null;

export interface SleepwatchDecision {
  action: SleepwatchAction;
  next: SleepwatchState;
  reason: string;
}

/**
 * Pure decision function — all I/O stays in tickSleepwatch so this is
 * exhaustively testable. `playing` is the noise server's listener truth.
 */
export function evaluateSleepwatch(opts: {
  hhmm: string;
  nowMs: number;
  states: Map<string, { state: string; position?: number | null }>;
  /** Listener-count truth; null = the status read FAILED. Unknown is not
   *  "stopped": treating a hiccup as silence once made the watcher drop an
   *  active session and let the noise play into mid-morning. */
  playing: boolean | null;
  st: SleepwatchState;
  /** House-wide Away mode (lib/away.ts): nobody is sleeping here tonight. */
  away?: boolean;
}): SleepwatchDecision {
  const { hhmm, nowMs, states, playing, st } = opts;
  const get = (id: string) => states.get(id)?.state ?? "unknown";

  const lightsOn = watchedLightEntities().filter((id) => get(id) === "on");

  // Shade movement: compare each cover's current report to the last tick's
  // snapshot. The snapshot rides in the state file so a restart just skips
  // one comparison instead of inventing an edge.
  const snap: Record<string, CoverSnap> = {};
  const opened: string[] = [];
  for (const id of coverEntities()) {
    const cur: CoverSnap = {
      s: get(id),
      p: typeof states.get(id)?.position === "number" ? (states.get(id)!.position as number) : null,
    };
    snap[id] = cur;
    if (movedOpen(st.coverSnap?.[id], cur)) opened.push(id);
  }
  const base = { ...st, coverSnap: snap };

  // Away mode: never arm, and stop a session WE own (set going before
  // leaving, or the mode flipped on mid-stream). Same stop semantics as a
  // wake-up: only affirmative silence skips it, and active clears only when
  // the stop succeeds. A stream someone else started stays untouched — a
  // cleaner's or child's choice is theirs, and away is not a wake-up for it.
  if (opts.away) {
    return {
      action: st.active && playing !== false ? "stop" : null,
      next: { ...base, active: false, latched: false, startedAtMs: null, retries: 0 },
      reason: "away mode",
    };
  }

  // Cancel needs positive evidence: a light truly on, or a shade actually
  // MOVING toward open. Never the clock (mornings end by opening the
  // blinds, not at 08:00 — owner's call, 2026-07-24), and never an entity
  // going "unavailable" mid-night.
  const cancel = lightsOn.length > 0 || opened.length > 0;

  if (cancel) {
    const why = lightsOn.length > 0 ? `light on: ${lightsOn[0]}` : `shade opening: ${opened[0]}`;
    // Stop unless affirmatively silent already: turn_off is idempotent, so
    // an unreadable status must not skip the wake-up stop. The next state
    // only clears active once the stop SUCCEEDS (the tick keeps the old
    // state on action failure), so a failed stop retries every tick.
    // A cancel condition resets the night: clear the latch so the next
    // fully-met bedtime (tonight or tomorrow) arms fresh.
    return {
      action: st.active && playing !== false ? "stop" : null,
      next: { ...base, active: false, latched: false, startedAtMs: null, retries: 0 },
      reason: why,
    };
  }

  // Arming needs every check affirmatively true — unknown/unavailable states
  // block a start (never wake anyone on missing data).
  const armed =
    inWindow(hhmm) &&
    watchedLightEntities().every((id) => get(id) === "off") &&
    get(TV_LIFT_ENTITY) === liftSleepState();

  if (playing === null) {
    // Status unreadable: change nothing about the noise. Never adopt,
    // latch, or clear active on a blind tick — the next readable status
    // decides. The cover snapshot still advances: it's a sensor baseline,
    // not noise state.
    return { action: null, next: base, reason: "noise status unreadable — holding state" };
  }

  if (playing) {
    // Adopt whatever is playing during a met-conditions bedtime so the
    // wake-up stop applies to it, however it was started.
    return armed && !st.active
      ? { action: null, next: { ...base, active: true, startedAtMs: null, retries: 0 }, reason: "adopted playing noise" }
      : { action: null, next: base, reason: "playing" };
  }

  if (st.active) {
    // We started it and nothing is playing. Within the grace window that's
    // interference (the C4 goodnight sweep killed the Yamaha ~40s after
    // both starts on the first real night) — retry. Beyond it, someone
    // turned it off on purpose: stand down for the night.
    const withinGrace =
      st.startedAtMs != null && nowMs - st.startedAtMs < RETRY_WINDOW_MS;
    if (armed && withinGrace && (st.retries ?? 0) < MAX_RETRIES) {
      return {
        action: "start",
        next: { ...base, active: true, startedAtMs: nowMs, retries: (st.retries ?? 0) + 1 },
        reason: "stream died right after start — retrying past the goodnight sweep",
      };
    }
    return {
      action: null,
      next: { ...base, active: false, latched: true, startedAtMs: null },
      reason: "noise stopped manually — latched for the night",
    };
  }

  if (armed && !st.latched) {
    return {
      action: "start",
      next: { ...base, active: true, startedAtMs: nowMs, retries: 0 },
      reason: "bedtime conditions met",
    };
  }

  return { action: null, next: base, reason: st.latched ? "latched" : "conditions not met" };
}

/**
 * Scheduler hook — called every 30s tick. Cheap when idle: outside the
 * window with nothing to clean up it returns before touching HA or the
 * noise server.
 */
export async function tickSleepwatch(): Promise<void> {
  let st = loadSleepwatch();
  if (!st.enabled || !noiseConfigured()) return;
  const { hhmm } = nowParts();
  if (!inWindow(hhmm) && !st.active) {
    if (st.latched) saveSleepwatch({ ...st, latched: false });
    return;
  }

  try {
    // Fresh status, not the 60s-lagged sensor: right after a start, a stale
    // zero would read as "manually stopped" and wrongly latch the night.
    // Cover positions ride along for the shade-movement edge.
    const [states, noise] = await Promise.all([
      getStates().then(
        (all) =>
          new Map(
            all.map((s) => [
              s.entity_id,
              {
                state: s.state,
                position:
                  typeof s.attributes.current_position === "number"
                    ? (s.attributes.current_position as number)
                    : null,
              },
            ]),
          ),
      ),
      noiseStatusFresh().catch(() => null),
    ]);
    // null = status read failed; evaluate treats that as unknown, not "off".
    const playing = noise ? noise.listeners > 0 : null;
    const { action, next, reason } = evaluateSleepwatch({
      hhmm, nowMs: Date.now(), states, playing, st, away: isAway(),
    });

    if (action) {
      const started = Date.now();
      try {
        if (action === "start") await noiseTurnOn();
        else await noiseTurnOff();
        audit({
          ts: new Date().toISOString(), user: "sleepwatch", deviceId: "master_bedroom__white_noise",
          entityId: "virtual.white_noise", command: action === "start" ? "sleep_noise_on" : "sleep_noise_off",
          args: { reason }, ok: true, durationMs: Date.now() - started,
        });
        console.log(`[sleepwatch] ${action}: ${reason}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit({
          ts: new Date().toISOString(), user: "sleepwatch", deviceId: "master_bedroom__white_noise",
          entityId: "virtual.white_noise", command: action === "start" ? "sleep_noise_on" : "sleep_noise_off",
          args: { reason }, ok: false, durationMs: Date.now() - started, error: message,
        });
        // A failed START latches (one honest attempt per episode, no 30s
        // retry storm at 2am); a failed STOP keeps active so the stop
        // retries next tick — noise must not outlive its welcome.
        st = action === "start" ? { ...st, active: false, latched: true } : st;
        saveSleepwatch(st);
        return;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(st)) {
      saveSleepwatch(next);
      // Every state transition leaves a trace — the silent night of
      // 2026-07-23/24 (noise ran to mid-morning, nothing in the logs) must
      // stay diagnosable from `railway logs` alone.
      console.log(`[sleepwatch] state: ${reason}`, next);
    }
  } catch (err) {
    console.error("[sleepwatch] tick failed:", err);
  }
}
