import type { Command } from "./commands";
import { registry, type Device } from "./registry";

/**
 * The picture Frames follow the house's day and night.
 *
 * The owner uses the Samsung Frames as photo frames: the three 32" sets in
 * the Dining area, and the Den and Lounge TVs whenever nobody is watching
 * them. A Frame that is "on" sits in art mode (every wake this house has
 * seen lands there, COMMISSIONING_LOG 2026-09-10), so "on as art" and
 * "on" are the same command. The rule, deliberately simple until the
 * owner has lived with it: **Night → all Frames off, Morning → all Frames
 * on.**
 *
 * Night and Morning are KNX scene switches (`light.knx_switch_all_house_*`),
 * not app scenes: the app cannot add devices to them, and their HA state
 * never returns to off after a press (2026-09-09 history: Night flipped on
 * at 19:17 and stayed on), so there is no "mode" to read — only the press.
 * The hook therefore rides the PRESS: whenever the app sends turn_on to one
 * of those switches (a card tap, or an automation step), the Frames follow.
 * A press on the wall keypad, or by Alexa, Siri / Apple Home or the HA
 * dashboard, bypasses the app; since 2026-09-16 Home Assistant relays
 * those (the KNX telegram on the scene address → `knx_event`; a service
 * call on the switch → `call_service` → an HA automation →
 * `POST /api/artframes`, lib/artframesHook), and the same follower runs —
 * the owner presses the wall far more than the app. The service-call road
 * also carries the app's own press back, so one press is one sweep
 * (`recordPress` below).
 *
 * One refinement is in (owner, 2026-09-10): **on a Night press, a set that
 * is not in art mode is left alone** — it is being watched, or was left on
 * a programme, and either way the house should not cut it off. "In art"
 * is SmartThings' tvChannelName (`art_mode_entity` on the row), and only
 * POSITIVE, FRESH evidence spares a set: an unavailable or unknown sensor
 * reads as art, so a missing signal never leaves a Frame lit all night,
 * and a reading that has not changed in hours is not evidence either
 * (`WATCHED_EVIDENCE_MAX_AGE_MS` — the sensor sticks, 2026-09-18).
 */

/** What the art-mode sensor reads while the set shows pictures. */
export const ART_MODE = "art";

/** A press as the house names it. */
export type Press = "night" | "morning";

/**
 * How far a press reaches, and whether it spares a set being watched.
 *
 * Night and Morning take every Frame. The three buttons by the front door
 * (owner, 2026-09-17) take a floor's worth: "Lights 6" switches the sixth
 * floor's lights and its Frames with them (the three Dining sets and the
 * Lounge TV), "Lights 5" the lower floor and the Den TV, and "Exit" the
 * whole house — all five off. Those arrive only through the HA relay
 * (`POST /api/artframes` with `floor` / `spare`), as "night" for off and
 * "morning" for on.
 *
 * `spare: false` turns the watched-set rule off for that press. The door
 * buttons are pressed on the way out, so nobody is watching — and the
 * sensor the rule reads is known to stick (the Lounge TV's read a video
 * app for four days of showing art, COMMISSIONING_LOG 2026-09-17), which
 * on those buttons would leave the biggest screen in the house lit.
 */
export interface PressScope {
  /** Only the Frames on this floor; every Frame when absent. */
  floor?: 5 | 6;
  /** false = darken a set even if its sensor says it is being watched. */
  spare?: boolean;
}

/** The press a follow command stands for (Night → Frames off, Morning → on). */
export function pressOf(follow: Command): Press {
  return follow.command === "turn_off" ? "night" : "morning";
}

/**
 * One press, one sweep — whichever way it arrived. The same press reaches
 * the follower by several roads at once: a card tap in the app AND, a
 * second later, Home Assistant relaying the service call that tap made
 * (ha/artframes_keypad.yaml, the Alexa/Siri/dashboard trigger); a keypad
 * whose direction memory sends two telegrams; an automation reloaded while
 * an event was in flight. A repeat of the same press inside this window is
 * dropped by `followArtFrames` and written to the audit log as a
 * duplicate. Night after Morning (or the reverse) is never a repeat.
 */
export const DUPLICATE_WINDOW_MS = 10_000;

const lastPress = new Map<string, number>();

/** Presses are remembered per reach: "Lights 6" then "Lights 5" two
 *  seconds apart on the way out are two presses, not a repeat. */
function pressKey(press: Press, floor?: 5 | 6): string {
  return floor == null ? press : `${press}:${floor}`;
}

/** Peek: has this press already run inside the window? Records nothing. */
export function duplicatePress(press: Press, now = Date.now(), floor?: 5 | 6): boolean {
  const prev = lastPress.get(pressKey(press, floor));
  return prev != null && now - prev < DUPLICATE_WINDOW_MS;
}

/** Record this press as run; true when it was a repeat (the caller then
 *  does nothing). A repeat does not extend the window — it is measured from
 *  the press that actually ran. */
export function recordPress(press: Press, now = Date.now(), floor?: 5 | 6): boolean {
  if (duplicatePress(press, now, floor)) return true;
  lastPress.set(pressKey(press, floor), now);
  return false;
}

/** Tests only. */
export function resetPressMemory(): void {
  lastPress.clear();
  sweepOwner.clear();
  sweepIntent.clear();
}

/**
 * A sweep is chased, because "sent" is not "obeyed" (owner, 2026-09-19: Exit
 * floor answered 202, the sweep logged `failed: []`, and the Den TV stayed
 * on). SmartThings had marked every Frame unavailable a minute after a quick
 * Night-then-Morning, and Home Assistant answers 200 to a service call
 * against an unavailable entity while nothing happens (lib/reachability).
 * So `followArtFrames` reads the sets back in the background and re-sends
 * where one positively contradicts the press — which includes the moment it
 * comes back from unavailable still lit.
 *
 * The window is minutes, not the interactive route's 30 s: a cloud
 * integration that dropped its devices takes that long to find them again.
 * Re-sends are spaced for a Frame's held power key and its boot.
 */
export const FRAME_VERIFY_MS = 180_000;
export const FRAME_POLL_MS = 10_000;
export const FRAME_REASSERT_AFTER_MS = 30_000;

/** Which sweep owns a Frame's verdict. A newer press over the same set takes
 *  it, and the older chase lets go rather than fight the newer intent. */
const sweepOwner = new Map<string, number>();
/** What the owning sweep wants of each Frame, and on whose behalf. */
const sweepIntent = new Map<string, { intent: Command; user: string }>();
let sweepSeq = 0;

export function claimFrames(frameIds: string[], intent?: Command, user = "system"): number {
  const token = ++sweepSeq;
  for (const id of frameIds) {
    sweepOwner.set(id, token);
    if (intent) sweepIntent.set(id, { intent, user });
    else sweepIntent.delete(id);
  }
  return token;
}

/** The sweep that owns a Frame now, and what it asked for — so a command
 *  from an older sweep that landed late can be followed by the current one. */
export function frameOwner(frameId: string): { token: number; intent?: Command; user?: string } | undefined {
  const token = sweepOwner.get(frameId);
  if (token == null) return undefined;
  return { token, ...sweepIntent.get(frameId) };
}

export function ownsFrame(frameId: string, token: number): boolean {
  return sweepOwner.get(frameId) === token;
}

/**
 * How long a "television" reading counts as evidence that a set is being
 * watched. The sensor is SmartThings' tvChannelName, and it sticks: the
 * Lounge TV's read a video app for four days while the set showed art
 * (2026-09-17), so every Night press spared the biggest screen in the
 * house on the strength of a reading nobody had refreshed. A reading is a
 * fact about the moment it changed, not about tonight; after this long it
 * is no longer evidence, and the set is darkened like the others. Four
 * hours outlasts a film or a match started that evening.
 */
export const WATCHED_EVIDENCE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** What the follower knows about an art-mode sensor: its reading and when
 *  that reading last changed (HA's `last_changed`). */
export interface SensorRead {
  state?: string;
  lastChanged?: string;
}

/**
 * Is this Frame showing television right now, as far as its sensor knows?
 * Only positive, FRESH evidence says yes: a non-art reading that changed
 * within `WATCHED_EVIDENCE_MAX_AGE_MS`. No sensor, no reading, an
 * unavailable / unknown state, a missing or unparseable timestamp, or a
 * reading older than the window all read as art.
 */
export function beingWatched(frame: Device, read: SensorRead | undefined, now = Date.now()): boolean {
  if (!frame.artModeEntityId || !read) return false;
  const { state, lastChanged } = read;
  if (state == null || state === "" || state === "unavailable" || state === "unknown") return false;
  if (state === ART_MODE) return false;
  const changedAt = lastChanged ? Date.parse(lastChanged) : NaN;
  if (!Number.isFinite(changedAt)) return false;
  return now - changedAt <= WATCHED_EVIDENCE_MAX_AGE_MS;
}

/**
 * Split the Frames a Night press should darken from the ones to spare.
 * Only a turn_off spares anything: turning on a set that is already on
 * changes nothing, so Morning takes them all.
 */
export function spareWatched(
  frames: Device[],
  follow: Command,
  readOf: (entityId: string) => SensorRead | undefined,
  now = Date.now(),
): { targets: Device[]; spared: Device[] } {
  if (follow.command !== "turn_off") return { targets: frames, spared: [] };
  const spared = frames.filter((f) => f.artModeEntityId && beingWatched(f, readOf(f.artModeEntityId), now));
  return { targets: frames.filter((f) => !spared.includes(f)), spared };
}

/** HA entity ids of the scene switches, as the KNX export named them. */
export const NIGHT_SCENE_SWITCH = "light.knx_switch_all_house_night";
export const MORNING_SCENE_SWITCH = "light.knx_switch_all_house_morning";
/** "Exit": the whole house off on the way out — the Frames with it, and
 *  nobody left to be watching one (owner, 2026-09-17). */
export const EXIT_SCENE_SWITCH = "light.knx_switch_all_house_exit";

/** Does a press of this switch spare a watched set? Night does; Exit
 *  empties the house, so it does not. */
export function sparesWatched(device: Device): boolean {
  return device.entityId !== EXIT_SCENE_SWITCH;
}

/**
 * Every device the map flags as a picture Frame — on one floor, when asked.
 * A Morning leaves out the sets the map marks `art_frame_off_only`: they go
 * dark with the house and stay dark until someone wants them (the Den TV,
 * 2026-09-22). Night, Exit and Exit floor still take them.
 */
export function artFrames(floor?: 5 | 6, press?: Press): Device[] {
  return registry().devices.filter(
    (d) =>
      d.artFrame === true &&
      (floor == null || d.floor === floor) &&
      !(press === "morning" && d.artFrameOffOnly === true),
  );
}

/**
 * What the Frames should do because of THIS command, or null when the
 * command is not a press of Night, Exit or Morning. Only a turn_on counts: a
 * scene switch's turn_off means nothing on the KNX side either.
 */
export function artFrameFollow(device: Device, cmd: Command): Command | null {
  if (cmd.command !== "turn_on" || device.category !== "scene_switch") return null;
  if (device.entityId === NIGHT_SCENE_SWITCH || device.entityId === EXIT_SCENE_SWITCH) return { command: "turn_off" };
  if (device.entityId === MORNING_SCENE_SWITCH) return { command: "turn_on" };
  return null;
}
