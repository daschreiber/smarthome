import fs from "node:fs";
import path from "node:path";

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
  | "volume";

export interface MapRow {
  entity_id: string;
  domain: "light" | "cover" | "climate" | "media_player";
  original_name: string;
  display_name: string;
  room: string;
  floor: 5 | 6 | null;
  category: string;
  group: string;
  visible: boolean;
}

export interface Device {
  id: string;
  entityId: string;
  kind: MapRow["domain"];
  label: string;
  room: string;
  floor: 5 | 6 | null;
  group: string;
  category: string;
  visible: boolean;
  capabilities: Capability[];
}

function slug(s: string): string {
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
      return ["set_temperature", "hvac_mode"];
    case "media_player":
      return ["on_off", "volume"];
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
    };
  });
}

let cache: { devices: Device[]; byId: Map<string, Device> } | null = null;

export function registry() {
  if (!cache) {
    const devices = buildDevices(loadRows());
    cache = { devices, byId: new Map(devices.map((d) => [d.id, d])) };
  }
  return cache;
}

export function getDevice(id: string): Device | undefined {
  return registry().byId.get(id);
}
