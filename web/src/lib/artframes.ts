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
 */

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
