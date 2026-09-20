import { getDevice, type Device } from "./registry";

/**
 * The whole-house modes as scenes. The house has no "mode" of its own:
 * Night, Morning, Exit and Welcome are KNX scene switches (category
 * `scene_switch`, room "Whole House") that Control4 programming reacts to,
 * and pressing one is a plain turn_on on that device — exactly what the
 * app's Night / Morning buttons and `control_device` send. An agent asked
 * to "put the house in night mode" should not have to hunt through the
 * device list for a switch labelled "All House Night", so the MCP server
 * (lib/mcp) lists these five as scenes beside the saved ones, with a clean
 * name, a stable id and a few spoken aliases, and `activate_scene` and a
 * scheduled `{type: "scene"}` step accept any of those spellings.
 *
 * The table is deliberately explicit rather than derived from the
 * registry: ids and aliases are vocabulary an agent may have memorised,
 * so they must not shift with a display-name edit in entity_map.json.
 * A mode whose switch is no longer in the registry simply disappears from
 * the list and refuses to resolve.
 */

export interface HouseMode {
  /** Stable scene id, e.g. `mode_night`. */
  id: string;
  /** Clean name, as the home app shows it. */
  name: string;
  /** The scene switch's app device id (lib/registry). */
  deviceId: string;
  /** Spoken forms that resolve to this mode, matched case-insensitively. */
  aliases: readonly string[];
}

export const HOUSE_MODES: readonly HouseMode[] = [
  {
    id: "mode_night",
    name: "Night",
    deviceId: "whole_house__all_house_night",
    aliases: ["night mode", "night", "sleep mode"],
  },
  {
    id: "mode_morning",
    name: "Morning",
    deviceId: "whole_house__all_house_morning",
    aliases: ["day mode", "morning mode", "morning", "day"],
  },
  {
    id: "mode_exit",
    name: "Exit",
    deviceId: "whole_house__all_house_exit",
    aliases: ["exit mode", "leaving", "away mode"],
  },
  {
    id: "mode_welcome",
    name: "Welcome",
    deviceId: "whole_house__welcome",
    aliases: ["welcome mode", "arriving"],
  },
  {
    id: "mode_main",
    name: "Main All House",
    deviceId: "whole_house__main_all_house",
    aliases: ["main all house", "main mode"],
  },
];

/** The mode's switch, when the registry still has it as a visible scene switch. */
export function houseModeDevice(mode: HouseMode): Device | undefined {
  const d = getDevice(mode.deviceId);
  return d && d.visible && d.category === "scene_switch" ? d : undefined;
}

/** The modes whose switch exists, in table order, each with its device. */
export function listHouseModes(): Array<{ mode: HouseMode; device: Device }> {
  const out: Array<{ mode: HouseMode; device: Device }> = [];
  for (const mode of HOUSE_MODES) {
    const device = houseModeDevice(mode);
    if (device) out.push({ mode, device });
  }
  return out;
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Resolve what an agent wrote to a house mode: its id (`mode_night`), its
 * name ("Night"), one of its aliases ("night mode", "sleep mode"), or the
 * switch's own device id — all case-insensitively, with spaces, hyphens and
 * underscores interchangeable. Undefined when it is not a mode, or the
 * mode's switch is not in the registry.
 */
export function resolveHouseMode(input: string): HouseMode | undefined {
  const wanted = normalise(input);
  if (!wanted) return undefined;
  for (const mode of HOUSE_MODES) {
    const forms = [mode.id, mode.name, mode.deviceId, ...mode.aliases].map(normalise);
    if (forms.includes(wanted) && houseModeDevice(mode)) return mode;
  }
  return undefined;
}

/** A stored scene id that names a mode (exact id only — storage is canonical). */
export function houseModeById(id: string): HouseMode | undefined {
  const mode = HOUSE_MODES.find((m) => m.id === id);
  return mode && houseModeDevice(mode) ? mode : undefined;
}

/** One line for a tool description: every accepted spelling per mode. */
export function houseModeVocabulary(): string {
  return HOUSE_MODES.map((m) => `${m.id} (${m.name}: ${m.aliases.map((a) => `"${a}"`).join(", ")})`).join("; ");
}
