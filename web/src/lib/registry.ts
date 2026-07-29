import fs from "node:fs";
import path from "node:path";
import { bedDeviceId, bedSides } from "./eightsleep";
import { noiseConfigured } from "./whitenoise";

/**
 * Device registry: loads the generated entity map (data/entity_map.json at the
 * repo root) and exposes stable application devices. The browser only ever
 * sees the application `id`, never raw Home Assistant entity IDs (see
 * IMPLEMENTATION_SPEC §6).
 */

export type Capability =
  | "on_off"
  | "brightness"
  | "open_close_stop"
  | "position"
  | "set_temperature"
  | "hvac_mode"
  | "fan_mode"
  | "volume"
  | "select_source"
  | "transport"
  | "vacuum_control"
  | "bed_level";

export interface MapRow {
  entity_id: string;
  domain: "light" | "cover" | "climate" | "media_player" | "vacuum";
  original_name: string;
  display_name: string;
  room: string;
  floor: 5 | 6 | null;
  category: string;
  group: string;
  visible: boolean;
  /** CoolMaster indoor units behind this zone (climate commands bypass Control4). */
  coolmaster_units?: string[];
  /** Keeps its own card in the room view instead of collapsing into "Room lights". */
  pinned?: boolean;
}

export interface Device {
  id: string;
  entityId: string;
  kind: MapRow["domain"] | "sauna" | "heating" | "noise" | "bed";
  label: string;
  room: string;
  floor: 5 | 6 | null;
  group: string;
  category: string;
  visible: boolean;
  capabilities: Capability[];
  /** Safety-sensitive devices require an explicit confirm on every command. */
  requiresConfirmation?: boolean;
  /** See MapRow.coolmaster_units. */
  coolmasterUnits?: string[];
  /** See MapRow.pinned. */
  pinned?: boolean;
}

/** Shared app-wide slug: scene and automation ids use the same rules as
 *  device ids (apostrophes collapse, not underscore). */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function capabilitiesFor(row: MapRow): Capability[] {
  switch (row.domain) {
    case "light":
      return row.category === "light_dimmer"
        ? ["on_off", "brightness"]
        : ["on_off"];
    case "cover":
      // All Control4 shades in the inventory report supported_features 15
      // (open/close/stop/position); position values are unreliable (-1 seen),
      // so expose stop-capable control and treat position as best-effort.
      return ["open_close_stop", "position"];
    case "climate":
      return ["set_temperature", "hvac_mode", "fan_mode"];
    case "media_player":
      // Control4 matrix zones have no turn_on and no play_media — a zone
      // wakes by selecting a source. The UI decides which controls to show
      // from the entity's live supported_features; unsupported service calls
      // are rejected by HA either way.
      return ["on_off", "volume", "select_source", "transport"];
    case "vacuum":
      return ["vacuum_control"];
  }
}

function loadRows(): MapRow[] {
  const candidates = [
    process.env.ENTITY_MAP_PATH,
    path.join(process.cwd(), "..", "data", "entity_map.json"),
    path.join(process.cwd(), "data", "entity_map.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(
    `entity_map.json not found; looked in: ${candidates.join(", ")}`,
  );
}

export function buildDevices(rows: MapRow[]): Device[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    // App-level policy: underfloor heating valve relays are hidden in the
    // entity map as raw KNX plumbing, but the app surfaces them as a clean
    // per-room heating control. kind "heating" keeps them out of every
    // lights fan-out ("all lights off" must never touch the floor).
    if (row.category === "floor_heating") {
      const room = row.room || "whole_house";
      return {
        id: `${slug(room)}__underfloor_heating`,
        entityId: row.entity_id,
        kind: "heating" as const,
        label: "Underfloor heating",
        room: row.room,
        floor: row.floor,
        group: "Climate & Comfort",
        category: row.category,
        visible: true,
        capabilities: ["on_off" as const],
      };
    }
    let id = `${slug(row.room || "whole_house")}__${slug(row.display_name)}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}_${n + 1}`; // stable de-dup, order comes from the sorted map file
    return {
      id,
      entityId: row.entity_id,
      kind: row.domain,
      label: row.display_name,
      room: row.room,
      floor: row.floor,
      group: row.group,
      category: row.category,
      visible: row.visible,
      capabilities: capabilitiesFor(row),
      ...(row.coolmaster_units?.length ? { coolmasterUnits: row.coolmaster_units } : {}),
      ...(row.pinned ? { pinned: true } : {}),
    };
  });
}

/**
 * Virtual devices live outside Home Assistant. The KLAFS sauna is driven by
 * its own service (see lib/sauna.ts); it appears here so the UI, command
 * layer, audit log, and later the conversational layer treat it uniformly.
 */
function virtualDevices(): Device[] {
  const devices: Device[] = [];
  if (process.env.SAUNA_BASE_URL && process.env.SAUNA_API_TOKEN) {
    devices.push({
      id: "sauna__klafs_sauna",
      entityId: "virtual.sauna",
      kind: "sauna",
      label: "Sauna",
      room: "Sauna",
      floor: 5,
      group: "Climate & Comfort",
      category: "sauna_heater",
      visible: true,
      capabilities: ["on_off", "set_temperature"],
      requiresConfirmation: true,
    });
  }
  // The white-noise machine (daschreiber/whitenoise): the app drives on/off
  // (the room's media_player joins/leaves the stream), controls sound type
  // and volume, and shows honest playing/idle state from the listener count.
  if (noiseConfigured()) {
    devices.push({
      id: "master_bedroom__white_noise",
      entityId: "virtual.white_noise",
      kind: "noise",
      // "Sleep sound", matching the Alexa/HA name (the entity was renamed to
      // dodge Amazon's Ambient Sounds phrase-hijack) — one vocabulary across
      // voice and screen. The id keeps the historical slug.
      label: "Sleep sound",
      room: "Master Bedroom",
      floor: 6,
      group: "Media",
      category: "noise_machine",
      visible: true,
      // on_off drives the room's Control4 zone (play/stop the stream) via HA;
      // volume is the stream's own level via the noise server.
      capabilities: ["on_off", "volume"],
    });
  }
  // Eight Sleep bed sides: the entities are REAL HA entities (unlike the
  // sauna), but their command surface is the eight_sleep integration's own
  // services, so kind "bed" is executed by lib/eightsleep, never by
  // buildServiceCall. One device per configured side.
  for (const s of bedSides()) {
    devices.push({
      id: bedDeviceId(s.side),
      entityId: s.targetEntity,
      kind: "bed",
      label: s.label,
      room: "Master Bedroom",
      floor: 6,
      group: "Climate & Comfort",
      category: "bed_side",
      visible: true,
      capabilities: ["on_off", "bed_level"],
    });
  }
  return devices;
}

let cache: { devices: Device[]; byId: Map<string, Device> } | null = null;

export function registry() {
  if (!cache) {
    const devices = [...buildDevices(loadRows()), ...virtualDevices()];
    cache = { devices, byId: new Map(devices.map((d) => [d.id, d])) };
  }
  return cache;
}

export function getDevice(id: string): Device | undefined {
  return registry().byId.get(id);
}
