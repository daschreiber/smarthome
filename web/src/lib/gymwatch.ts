import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./store";
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
 *   known state. After a restart the first readable state is a baseline,
 *   never an action.
 * - The off goes out only when the TV affirmatively reads on. Some TVs'
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
  /** Last KNOWN lights state; null = no baseline yet. */
  lastLightsOn: boolean | null;
}

const DEFAULT_STATE: GymwatchState = { enabled: true, lastLightsOn: null };

function storePath(): string {
  if (process.env.GYMWATCH_PATH) return process.env.GYMWATCH_PATH;
  if (fs.existsSync("/data")) return "/data/gymwatch.json";
  return path.join(process.cwd(), "gymwatch.json");
}

export function loadGymwatch(): GymwatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<GymwatchState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
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

/** Scheduler hook, every 30s tick. */
export async function tickGymwatch(): Promise<void> {
  if (!loadGymwatch().enabled) return;
  const tv = gymTvDevice();
  if (!tv) return;

  const [lightsRes, tvRes] = await Promise.allSettled([getState(GYM_LIGHTS_ENTITY), getState(GYM_TV_ENTITY)]);
  const lightsOn = lightsRes.status === "fulfilled" ? lightsOnFromState(lightsRes.value?.state) : null;
  const tvOn = tvRes.status === "fulfilled" ? tvOnFromState(tvRes.value?.state) : null;

  // Re-read after the awaits: a pause flipped meanwhile wins.
  const st = loadGymwatch();
  if (!st.enabled) return;
  const { action, next } = evaluateGymFollow(lightsOn, st);
  // Persist the baseline before acting: a crash mid-command must not replay
  // the edge on the next tick.
  if (next.lastLightsOn !== st.lastLightsOn) saveGymwatch(next);
  if (!action) return;

  if (action === "tv_off" && tvOn !== true) {
    audit({
      ts: new Date().toISOString(), user: "gymwatch", deviceId: tv.id, entityId: tv.entityId,
      command: "gym_tv_off", args: { lights: "off", skipped: `TV reads ${tvRes.status === "fulfilled" ? tvRes.value?.state ?? "missing" : "unreadable"}` },
      ok: true, durationMs: 0,
    });
    console.log(`[gymwatch] lights off → TV already off or unreadable, nothing sent`);
    return;
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
