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
 * off (the two bedside reading lights are allowed on), all three shades
 * closed, the TV lift stowed — the noise starts. It stops at 08:00, or the
 * moment a watched light comes on or a shade opens. Evaluated by the
 * in-process scheduler on its 30s tick; a small JSON file carries state
 * across restarts.
 *
 * Deliberate semantics, so the watcher never fights a human:
 * - If noise is already playing when conditions are met, the watcher ADOPTS
 *   it (so it still gets the 08:00 auto-off) rather than re-commanding.
 * - If the watcher started the noise and someone turns it off (bedside
 *   remote, the app) while the room still looks asleep, it LATCHES off for
 *   the night instead of re-firing 30s later. The latch clears when a
 *   cancel condition appears — opening a shade or turning on a light resets
 *   the night, and the next fully-met bedtime starts fresh.
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
}

const DEFAULT_STATE: SleepwatchState = { enabled: true, active: false, latched: false };

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

export function shadeEntities(): string[] {
  return registry()
    .devices.filter((d) => d.room === SLEEP_ROOM && d.kind === "cover" && d.visible)
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
  states: Map<string, { state: string }>;
  playing: boolean;
  st: SleepwatchState;
}): SleepwatchDecision {
  const { hhmm, states, playing, st } = opts;
  const get = (id: string) => states.get(id)?.state ?? "unknown";

  const lightsOn = watchedLightEntities().filter((id) => get(id) === "on");
  const shadesOpen = shadeEntities().filter((id) =>
    ["open", "opening"].includes(get(id)),
  );
  // Cancel needs positive evidence (a light truly on, a shade truly open) —
  // an entity going "unavailable" must not kill the noise mid-night.
  const cancel = !inWindow(hhmm) || lightsOn.length > 0 || shadesOpen.length > 0;

  if (cancel) {
    const why = !inWindow(hhmm)
      ? `window ended (${hhmm})`
      : lightsOn.length > 0
        ? `light on: ${lightsOn[0]}`
        : `shade open: ${shadesOpen[0]}`;
    // A cancel condition resets the night: clear the latch so the next
    // fully-met bedtime (tonight or tomorrow) arms fresh.
    return {
      action: st.active && playing ? "stop" : null,
      next: { ...st, active: false, latched: false },
      reason: why,
    };
  }

  // Arming needs every check affirmatively true — unknown/unavailable states
  // block a start (never wake anyone on missing data).
  const armed =
    inWindow(hhmm) &&
    watchedLightEntities().every((id) => get(id) === "off") &&
    shadeEntities().every((id) => get(id) === "closed") &&
    get(TV_LIFT_ENTITY) === liftSleepState();

  if (playing) {
    // Adopt whatever is playing during a met-conditions bedtime so the
    // 08:00 stop applies to it, however it was started.
    return armed && !st.active
      ? { action: null, next: { ...st, active: true }, reason: "adopted playing noise" }
      : { action: null, next: st, reason: "playing" };
  }

  if (st.active) {
    // We started it, nothing is playing, and no cancel condition explains
    // it: someone turned it off on purpose. Stand down for the night.
    return {
      action: null,
      next: { ...st, active: false, latched: true },
      reason: "noise stopped manually — latched for the night",
    };
  }

  if (armed && !st.latched) {
    return { action: "start", next: { ...st, active: true }, reason: "bedtime conditions met" };
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
    const playing = (noise?.listeners ?? 0) > 0;
    const { action, next, reason } = evaluateSleepwatch({ hhmm, states, playing, st });

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
    if (JSON.stringify(next) !== JSON.stringify(st)) saveSleepwatch(next);
  } catch (err) {
    console.error("[sleepwatch] tick failed:", err);
  }
}
