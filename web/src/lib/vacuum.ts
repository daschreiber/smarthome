/**
 * Roborock map parsing. The roborock.get_maps service response carries the
 * named rooms (segments) of each vacuum's floor map; the Clean panel uses
 * them for per-room cleaning. Names are managed in the Roborock app.
 */

export interface Segment {
  id: number;
  name: string;
}

/** service_response: { <entity_id>: { maps: [{ flag, name, rooms: { <id>: <name> } }] } } */
export function parseSegments(
  resp: unknown,
  entityId: string,
): { segments: Segment[]; map: string | null } {
  const forEntity = (resp as Record<string, unknown> | null)?.[entityId];
  const maps = (forEntity as { maps?: unknown } | undefined)?.maps;
  if (!Array.isArray(maps) || maps.length === 0) return { segments: [], map: null };
  // One vacuum per floor, so each holds a single map; take the first.
  const m = maps[0] as { name?: unknown; rooms?: unknown };
  const rooms = m.rooms && typeof m.rooms === "object" ? (m.rooms as Record<string, unknown>) : {};
  const segments = Object.entries(rooms)
    .map(([id, name]) => ({ id: Number(id), name: typeof name === "string" ? name : `Room ${id}` }))
    .filter((s) => Number.isInteger(s.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { segments, map: typeof m.name === "string" ? m.name : null };
}
