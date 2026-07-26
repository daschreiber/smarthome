/**
 * Grouping for the Automations list: automations that act on the same room
 * belong together, so an on/off pair ("Balcony lights at sunset" / "Balcony
 * lights off at 02:00") reads as one routine instead of scattering through
 * the schedule-ordered list. The group is derived from the actions — nothing
 * manual to maintain. Client-safe: no Node imports.
 */

export interface GroupableAction {
  type: "scene" | "room" | "device";
  room?: string;
  deviceId?: string;
}

export const SCENES_GROUP = "Scenes";
export const MIXED_GROUP = "Several rooms";
export const OTHER_GROUP = "Other";
/** Devices mapped to this pseudo-room span rooms by definition (e.g. the
 *  all-rooms closet lightstrip), so they group under "Several rooms". */
export const WHOLE_HOUSE_ROOM = "Whole House";

export function automationGroup(
  steps: Array<{ actions: GroupableAction[] }>,
  roomOf: (deviceId: string) => string | undefined,
): string {
  const rooms = new Set<string>();
  let hasScene = false;
  for (const s of steps) {
    for (const a of s.actions) {
      if (a.type === "room" && a.room) rooms.add(a.room);
      else if (a.type === "device" && a.deviceId) {
        const r = roomOf(a.deviceId);
        if (r) rooms.add(r);
      } else if (a.type === "scene") hasScene = true;
    }
  }
  if (rooms.has(WHOLE_HOUSE_ROOM)) return MIXED_GROUP;
  if (rooms.size === 1) return [...rooms][0];
  if (rooms.size > 1) return MIXED_GROUP;
  return hasScene ? SCENES_GROUP : OTHER_GROUP;
}
