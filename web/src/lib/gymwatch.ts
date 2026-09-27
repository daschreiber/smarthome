import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { callService, getState } from "./ha";
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
 * - Once the rule has switched the TV on, it opens the Apple TV app, where
 *   the owner runs Apple Fitness (owner request, 2026-09-27). The app opens
 *   only when the TV was off before the on — a TV already on is showing
 *   something someone chose — and only once the TV reads on (a Samsung
 *   takes a few seconds to accept an app launch). This runs apart from the
 *   tick so the scheduler never waits on a waking TV; it gives up if the
 *   lights go off or the rule is paused meanwhile, or if the TV hasn't
 *   woken within FITNESS_WAIT_MS.
 */

/** The gym's lights (one KNX dimmer) and the TV, as HA names them. The TV's
 *  id was read from HA by the owner, 2026-09-27. */
export const GYM_LIGHTS_ENTITY = "light.knx_dimmer_gym_lights";
export const GYM_TV_ENTITY = "media_player.gym_gym_tv";

/** The Samsung (Tizen) id of the Apple TV app, where Apple Fitness lives on
 *  this TV. The TV doesn't list its apps to HA (its source list is only
 *  TV/HDMI), so the app is opened by id: samsungtv's play_media with
 *  media_content_type "app". */
export const FITNESS_APP_ID = "3201807016597";
export const FITNESS_POLL_MS = 3_000;
export const FITNESS_WAIT_MS = 60_000;

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

  // Read the TV before an on, too: the app is opened only on a TV this rule
  // actually woke, never over something already on screen.
  let tvWasOn: boolean | null = null;
  if (action === "tv_on") {
    try {
      tvWasOn = tvOnFromState((await getState(GYM_TV_ENTITY))?.state);
    } catch {
      tvWasOn = null;
    }
    // Pause or re-enable while the TV was read wins, as on the off path.
    const now = loadGymwatch();
    if (!now.enabled || now.lastLightsOn !== next.lastLightsOn) return;
  }

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
  if (action === "tv_on" && !error && tvWasOn === false) {
    // Not awaited: the scheduler must not wait on a waking TV.
    void openFitnessWhenAwake(tv).catch((err) => console.error("[gymwatch] fitness launch failed:", err));
  }
}

let launching = false;
/** Bumped by tests to stop a launcher left running by an earlier test. */
let epoch = 0;
export function _resetGymwatchForTests(): void {
  epoch++;
  launching = false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the TV to read on, then open the Apple TV app. One at a time. */
export async function openFitnessWhenAwake(tv: Device): Promise<void> {
  if (launching) return;
  launching = true;
  const mine = epoch;
  const started = Date.now();
  const record = (ok: boolean, extra: { skipped?: string; error?: string }) => {
    audit({
      ts: new Date().toISOString(), user: "gymwatch", deviceId: tv.id, entityId: tv.entityId,
      command: "gym_tv_app", args: { app: FITNESS_APP_ID, ...(extra.skipped ? { skipped: extra.skipped } : {}) },
      ok, durationMs: Date.now() - started, error: extra.error,
    });
  };
  try {
    while (Date.now() - started < FITNESS_WAIT_MS) {
      await sleep(FITNESS_POLL_MS);
      if (mine !== epoch) return;
      // Lights off again, or paused: the moment has passed.
      let st: GymwatchState;
      try {
        st = loadGymwatch();
      } catch {
        return;
      }
      if (!st.enabled || st.lastLightsOn !== true) {
        record(true, { skipped: "lights off or paused before the TV woke" });
        return;
      }
      let on: boolean | null = null;
      try {
        on = tvOnFromState((await getState(GYM_TV_ENTITY))?.state);
      } catch {
        on = null;
      }
      if (on !== true) continue;
      // The stored state lags the lights by up to a tick: ask the lights
      // themselves before opening anything. Only a real "off" stops it.
      let lights: boolean | null = null;
      try {
        lights = lightsOnFromState((await getState(GYM_LIGHTS_ENTITY))?.state);
      } catch {
        lights = null;
      }
      if (mine !== epoch) return;
      if (lights === false) {
        record(true, { skipped: "lights off or paused before the TV woke" });
        return;
      }
      let error: string | undefined;
      try {
        await callService("media_player", "play_media", {
          entity_id: tv.entityId, media_content_type: "app", media_content_id: FITNESS_APP_ID,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      record(!error, { error });
      console.log(`[gymwatch] TV awake → Apple TV app` + (error ? ` FAILED: ${error}` : ""));
      return;
    }
    record(false, { skipped: `TV not on within ${FITNESS_WAIT_MS / 1000}s`, error: "TV did not wake" });
  } finally {
    if (mine === epoch) launching = false;
  }
}
