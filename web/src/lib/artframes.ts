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
 * A press on the wall keypad bypasses the app and is not seen; that is the
 * first refinement to make if it matters.
 *
 * One refinement is in (owner, 2026-09-10): **on a Night press, a set that
 * is not in art mode is left alone** — it is being watched, or was left on
 * a programme, and either way the house should not cut it off. "In art"
 * is SmartThings' tvChannelName (`art_mode_entity` on the row), and only
 * POSITIVE evidence spares a set: an unavailable or unknown sensor reads as
 * art, so a missing signal never leaves a Frame lit all night.
 */

/** What the art-mode sensor reads while the set shows pictures. */
export const ART_MODE = "art";

/** Is this Frame showing television right now, as far as its sensor knows? */
export function beingWatched(frame: Device, state: string | undefined): boolean {
  if (!frame.artModeEntityId) return false;
  if (state == null || state === "" || state === "unavailable" || state === "unknown") return false;
  return state !== ART_MODE;
}

/**
 * Split the Frames a Night press should darken from the ones to spare.
 * Only a turn_off spares anything: turning on a set that is already on
 * changes nothing, so Morning takes them all.
 */
export function spareWatched(
  frames: Device[],
  follow: Command,
  stateOf: (entityId: string) => string | undefined,
): { targets: Device[]; spared: Device[] } {
  if (follow.command !== "turn_off") return { targets: frames, spared: [] };
  const spared = frames.filter((f) => f.artModeEntityId && beingWatched(f, stateOf(f.artModeEntityId)));
  return { targets: frames.filter((f) => !spared.includes(f)), spared };
}

/** HA entity ids of the two scene switches, as the KNX export named them. */
export const NIGHT_SCENE_SWITCH = "light.knx_switch_all_house_night";
export const MORNING_SCENE_SWITCH = "light.knx_switch_all_house_morning";

/** Every device the map flags as a picture Frame. */
export function artFrames(): Device[] {
  return registry().devices.filter((d) => d.artFrame === true);
}

/**
 * What the Frames should do because of THIS command, or null when the
 * command is not a press of Night or Morning. Only a turn_on counts: a
 * scene switch's turn_off means nothing on the KNX side either.
 */
export function artFrameFollow(device: Device, cmd: Command): Command | null {
  if (cmd.command !== "turn_on" || device.category !== "scene_switch") return null;
  if (device.entityId === NIGHT_SCENE_SWITCH) return { command: "turn_off" };
  if (device.entityId === MORNING_SCENE_SWITCH) return { command: "turn_on" };
  return null;
}
