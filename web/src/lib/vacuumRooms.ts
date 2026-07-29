import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";
import type { Segment } from "./vacuum";

/**
 * App-side names for Roborock map segments. The robots' own maps were never
 * named — roborock.get_maps returns bare ids ("Room 16") — and fixing that
 * would mean the Roborock app. Instead the segment-id → room-name mapping
 * lives here and is edited from the Clean panel's "Name rooms" mode.
 * Stored like favorites: a small JSON file. data/vacuum_rooms.json in the
 * repo is the seed; runtime renames rewrite the deployed copy, which on
 * Railway's ephemeral filesystem lasts until the next deploy — commit the
 * mapping back to the repo once it has settled.
 */

type Store = Record<string, Record<string, string>>;

function storePath(): string {
  if (process.env.VACUUM_ROOMS_PATH) return process.env.VACUUM_ROOMS_PATH;
  const candidates = [
    path.join(process.cwd(), "..", "data", "vacuum_rooms.json"),
    path.join(process.cwd(), "data", "vacuum_rooms.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[candidates.length - 1];
}

function load(): Store {
  return readJsonFile<Store>(storePath(), {});
}

export function segmentNames(entityId: string): Record<string, string> {
  return load()[entityId] ?? {};
}

export function setSegmentName(entityId: string, segmentId: number, name: string | null): void {
  const all = load();
  const forEntity = all[entityId] ?? {};
  if (name) forEntity[String(segmentId)] = name;
  else delete forEntity[String(segmentId)];
  all[entityId] = forEntity;
  writeJsonFile(storePath(), all);
}

export type NamedSegment = Segment & { named: boolean };

/**
 * Overlay app names onto the raw map segments. Named rooms sort first
 * (alphabetically), the still-numbered remainder by id, so real names never
 * hide between "Room 21" and "Room 22".
 */
export function applySegmentNames(segments: Segment[], entityId: string): NamedSegment[] {
  const names = segmentNames(entityId);
  return segments
    .map((s) => {
      const appName = names[String(s.id)];
      if (appName) return { id: s.id, name: appName, named: true };
      // A segment named on the robot's own map counts as named too.
      return { ...s, named: s.name !== `Room ${s.id}` };
    })
    .sort((a, b) =>
      a.named !== b.named ? (a.named ? -1 : 1) : a.named ? a.name.localeCompare(b.name) : a.id - b.id,
    );
}
