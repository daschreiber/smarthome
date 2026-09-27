import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { getState } from "./ha";
import { registry, type Device } from "./registry";

/**
 * Gym TV follower: the Gym TV goes on and off with the gym lights (owner
 * request, 2026-09-27). Whenever the gym lights turn ON — from the wall, a
 * scene, Control4 or the app — the TV turns on; whenever they turn OFF, the
 * TV turns off.
 *
 * A standing house rule like the Sauna and TV followers, NOT a user-authored
 * automation: the trigger is the lights' STATE, which the step builder can't
 * express. Evaluated on the scheduler's 30s tick.
 *
 * Deliberate semantics, the same as the other followers:
 * - EDGES only, never levels: the rule reacts to the lights CHANGING between
 *   off and on. Dimming is not an edge. Someone who switches the TV off with
 *   the lights on (or on with the lights off) is making a choice, and the
 *   rule never fights it.
 * - Unknown is not "off": an unreadable or unavailable light holds the last
 *   known state. With no stored baseline (first run, or just re-enabled) the
 *   first readable state is a baseline, never an action. The baseline is
 *   kept on the volume across restarts, like the other followers', so a
 *   lights change during a deploy is still followed.
 * - The off goes out only when the TV affirmatively reads on, read after
 *   the edge is known, just before the send. Some TVs'
 *   network "off" is a power-key toggle, so sent at a set that is already off
 *   it could switch it ON. The on is sent regardless: a TV that is already
 *   on ignores it.
 * - A pause flipped while HA is being read wins.
 */

/** The gym's lights (one KNX dimmer) and the TV, as HA names them. The TV's
 *  id was read from HA by the owner, 2026-09-27. */
export const GYM_LIGHTS_ENTITY = "light.knx_dimmer_gym_lights";
export const GYM_TV_ENTITY = "media_player.gym_gym_tv";

export interface GymwatchState {
  enabled: boolean;
  /** Last KNOWN lights state, kept across restarts; null = no baseline yet. */
  lastLightsOn: boolean | null;
}

const DEFAULT_STATE: GymwatchState = { enabled: true, lastLightsOn: null };

function storePath(): string {
  if (process.env.GYMWATCH_PATH) return process.env.GYMWATCH_PATH;
  if (fs.existsSync("/data")) return "/data/gymwatch.json";
  return path.join(process.cwd(), "gymwatch.json");
}

/** A missing file is a fresh start; a corrupt one is an error (lib/store),
 *  so a damaged file never quietly turns a paused rule back on. */
export function loadGymwatch(): GymwatchState {
  return { ...DEFAULT_STATE, ...readJsonFile<Partial<GymwatchState>>(storePath(), {}) };
}

export function saveGymwatch(st: GymwatchState): void {
  writeJsonFile(storePath(), st);
}

export function gymTvDevice(): Device | null {
  return registry().devices.find((d) => d.entityId === GYM_TV_ENTITY) ?? null;
}

/** The follower exists once the TV is in the map (the lights always are). */
export function gymwatchAvailable(): boolean {
  return gymTvDevice() !== null;
}

/** A light's HA state as on/off, or null when it proves nothing. */
export function lightsOnFromState(state: string | undefined | null): boolean | null {
  if (state === "on") return true;
  if (state === "off") return false;
  return null;
}

/** A media player's HA state as on/off, or null when it proves nothing. */
export function tvOnFromState(state: string | undefined | null): boolean | null {
  if (state == null) return null;
  if (["on", "playing", "paused", "idle", "buffering"].includes(state)) return true;
  if (state === "off" || state === "standby") return false;
  return null;
}

export type GymFollowAction = "tv_on" | "tv_off" | null;

/** Pure edge detector; all I/O stays in tickGymwatch. */
export function evaluateGymFollow(
  lightsOn: boolean | null,
  st: GymwatchState,
): { action: GymFollowAction; next: GymwatchState } {
  if (lightsOn === null) return { action: null, next: st };
  if (st.lastLightsOn === null) return { action: null, next: { ...st, lastLightsOn: lightsOn } };
  if (lightsOn === st.lastLightsOn) return { action: null, next: st };
  return { action: lightsOn ? "tv_on" : "tv_off", next: { ...st, lastLightsOn: lightsOn } };
}

/** One pass at a time: the scheduler's setInterval doesn't wait for a slow
 *  pass, and two overlapping passes could send a stale command after a
 *  newer one. A tick that finds one in flight is skipped; the next runs. */
let inFlight = false;

/** Scheduler hook, every 30s tick. */
export async function tickGymwatch(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await tickOnce();
  } finally {
    inFlight = false;
  }
}

async function tickOnce(): Promise<void> {
  if (!loadGymwatch().enabled) return;
  const tv = gymTvDevice();
  if (!tv) return;

  let lightsOn: boolean | null = null;
  try {
    lightsOn = lightsOnFromState((await getState(GYM_LIGHTS_ENTITY))?.state);
  } catch {
    // Unreadable proves nothing: hold the last known state.
  }

  // Re-read after the await: a pause flipped meanwhile wins.
  const st = loadGymwatch();
  if (!st.enabled) return;
  const { action, next } = evaluateGymFollow(lightsOn, st);
  // Persist the baseline before acting: a crash mid-command must not replay
  // the edge on the next tick.
  if (next.lastLightsOn !== st.lastLightsOn) saveGymwatch(next);
  if (!action) return;

  if (action === "tv_off") {
    // The TV is read only now, right before the off: a reading taken
    // alongside the lights could be stale by the time the edge is known,
    // and a power-key off sent at a set just switched off turns it ON.
    let tvState: string;
    try {
      tvState = (await getState(GYM_TV_ENTITY))?.state ?? "missing";
    } catch {
      tvState = "unreadable";
    }
    // Pause, re-enable or a newer edge while the TV was read: this off is stale.
    const now = loadGymwatch();
    if (!now.enabled || now.lastLightsOn !== next.lastLightsOn) return;
    if (tvOnFromState(tvState) !== true) {
      audit({
        ts: new Date().toISOString(), user: "gymwatch", deviceId: tv.id, entityId: tv.entityId,
        command: "gym_tv_off", args: { lights: "off", skipped: `TV reads ${tvState}` },
        ok: true, durationMs: 0,
      });
      console.log(`[gymwatch] lights off → TV already off or unreadable, nothing sent`);
      return;
    }
  }

  const started = Date.now();
  let error: string | undefined;
  try {
    await executeOnDevice(tv, { command: action === "tv_on" ? "turn_on" : "turn_off" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  audit({
    ts: new Date().toISOString(), user: "gymwatch", deviceId: tv.id, entityId: tv.entityId,
    command: action === "tv_on" ? "gym_tv_on" : "gym_tv_off",
    args: { lights: action === "tv_on" ? "on" : "off" },
    ok: !error, durationMs: Date.now() - started, error,
  });
  console.log(
    `[gymwatch] lights ${action === "tv_on" ? "on → TV on" : "off → TV off"}` + (error ? ` FAILED: ${error}` : ""),
  );
}
