import fs from "node:fs";
import path from "node:path";
import { nowParts } from "./automations";
import { audit } from "./audit";
import { getStates } from "./ha";
import { registry } from "./registry";
import { noiseConfigured, noiseStatusFresh, noiseTurnOff, noiseTurnOn } from "./whitenoise";

/**
 * Sleep watcher: condition-triggered white noise for the Master Bedroom.
 *
 * The rooms's state IS the trigger — no button pressed, no time picked.
 * Between 22:00 and 08:00, when the room "looks like bedtime" — every light
 * off (the two bedside reading lights are allowed on) and the TV lift
 * stowed — the noise starts. It stops at 08:00 or the moment a watched
 * light comes on. Evaluated by the in-process scheduler on its 30s tick; a
 * small JSON file carries state across restarts.
 *
 * Shades are deliberately NOT a condition (learned the hard way on
 * 2026-07-22's first real night): the Control4 covers' position feedback is
 * stuck near 1%, so the entities report "open" forever — even shut tight.
 * "All shades closed" could never be true and the watcher never armed. A
 * condition that reality can't satisfy isn't a condition, it's an off
 * switch.
 *
 * Deliberate semantics, so the watcher never fights a human:
 * - If noise is already playing when conditions are met, the watcher ADOPTS
 *   it (so it still gets the 08:00 auto-off) rather than re-commanding.
 * - If the watcher started the noise and someone turns it off (bedside
 *   remote, the app) while the room still looks asleep, it LATCHES off for
 *   the night instead of re-firing 30s later. The latch clears when a
 *   cancel condition appears — a light on / window end resets the night,
 *   and the next fully-met bedtime arms fresh.
 * - EXCEPT within the first 3 minutes of a watcher-started stream: the
 *   same night the shades bug surfaced, the Control4 goodnight sweep
 *   turned the Yamaha off twice ~40s after the stream started. A death
 *   that early is interference, not intent — retry (twice, then latch).
 * - The TV lift going down does NOT stop the noise (it only gates arming):
 *   late-night TV with noise running is the couple's call, not ours.
 */

export const SLEEP_ROOM = "Master Bedroom";
export const WINDOW_START = "22:00"; // inclusive
export const WINDOW_END = "08:00"; // exclusive

/** Bedside reading lights: allowed on at bedtime, and turning one on at
 *  3am doesn't kill the noise either — the exemption is symmetric. */
export const READING_LIGHTS = new Set([
  "light.knx_switch_master_bedroom_read_left",
  "light.knx_switch_master_bedroom_read_right",
]);

export const TV_LIFT_ENTITY = "light.knx_switch_mbr_tv_lift";
/** Relay state that means "lift stowed for sleep" ("up" per the household).
 *  If the polarity turns out inverted, set SLEEPWATCH_LIFT_STATE=on. */
export function liftSleepState(): string {
  return process.env.SLEEPWATCH_LIFT_STATE || "off";
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
  fs.writeFileSync(storePath(), JSON.stringify(st, null, 2));
}

export function inWindow(hhmm: string): boolean {
  // The window crosses midnight, so it's an OR, not a range.
  return hhmm >= WINDOW_START || hhmm < WINDOW_END;
}

/** The lights whose being ON means "not asleep": every visible real light in
 *  the room except the bedside reading pair. Derived from the registry so a
 *  future light joins the watch automatically. */
export function watchedLightEntities(): string[] {
  return registry()
    .devices.filter(
      (d) =>
        d.room === SLEEP_ROOM &&
        d.kind === "light" &&
        d.visible &&
        d.group === "Lighting" &&
        d.category !== "scene_switch" &&
        !READING_LIGHTS.has(d.entityId),
    )
    .map((d) => d.entityId);
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
  states: Map<string, { state: string }>;
  /** Listener-count truth; null = the status read FAILED. Unknown is not
   *  "stopped": treating a hiccup as silence once made the watcher drop an
   *  active session and let the noise play into mid-morning. */
  playing: boolean | null;
  st: SleepwatchState;
}): SleepwatchDecision {
  const { hhmm, nowMs, states, playing, st } = opts;
  const get = (id: string) => states.get(id)?.state ?? "unknown";

  const lightsOn = watchedLightEntities().filter((id) => get(id) === "on");
  // Cancel needs positive evidence (a light truly on) — an entity going
  // "unavailable" must not kill the noise mid-night. Shades are no signal
  // at all: see the header comment.
  const cancel = !inWindow(hhmm) || lightsOn.length > 0;

  if (cancel) {
    const why = !inWindow(hhmm) ? `window ended (${hhmm})` : `light on: ${lightsOn[0]}`;
    // Stop unless affirmatively silent already: turn_off is idempotent, so
    // an unreadable status must not skip the morning stop. The next state
    // only clears active once the stop SUCCEEDS (the tick keeps the old
    // state on action failure), so a failed stop retries every tick.
    // A cancel condition resets the night: clear the latch so the next
    // fully-met bedtime (tonight or tomorrow) arms fresh.
    return {
      action: st.active && playing !== false ? "stop" : null,
      next: { ...st, active: false, latched: false, startedAtMs: null, retries: 0 },
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
    // Status unreadable: change nothing. Never adopt, latch, or clear
    // active on a blind tick — the next readable status decides.
    return { action: null, next: st, reason: "noise status unreadable — holding state" };
  }

  if (playing) {
    // Adopt whatever is playing during a met-conditions bedtime so the
    // 08:00 stop applies to it, however it was started.
    return armed && !st.active
      ? { action: null, next: { ...st, active: true, startedAtMs: null, retries: 0 }, reason: "adopted playing noise" }
      : { action: null, next: st, reason: "playing" };
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
        next: { ...st, active: true, startedAtMs: nowMs, retries: (st.retries ?? 0) + 1 },
        reason: "stream died right after start — retrying past the goodnight sweep",
      };
    }
    return {
      action: null,
      next: { ...st, active: false, latched: true, startedAtMs: null },
      reason: "noise stopped manually — latched for the night",
    };
  }

  if (armed && !st.latched) {
    return {
      action: "start",
      next: { ...st, active: true, startedAtMs: nowMs, retries: 0 },
      reason: "bedtime conditions met",
    };
  }

  return { action: null, next: st, reason: st.latched ? "latched" : "conditions not met" };
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
    const [states, noise] = await Promise.all([
      getStates().then((all) => new Map(all.map((s) => [s.entity_id, { state: s.state }]))),
      noiseStatusFresh().catch(() => null),
    ]);
    // null = status read failed; evaluate treats that as unknown, not "off".
    const playing = noise ? noise.listeners > 0 : null;
    const { action, next, reason } = evaluateSleepwatch({ hhmm, nowMs: Date.now(), states, playing, st });

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
