import { NextRequest, NextResponse } from "next/server";
import { callServiceWithResponse } from "@/lib/ha";
import { getDevice, registry, type Device } from "@/lib/registry";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { parseSegments, type Segment } from "@/lib/vacuum";
import { applySegmentNames, setSegmentName } from "@/lib/vacuumRooms";

/**
 * Vacuum map segments (the rooms on the Roborock's own floor map), fetched
 * via the roborock.get_maps service so the Clean panel can offer per-room
 * cleaning. The robot's map only knows numeric ids ("Room 16"); app-side
 * names from data/vacuum_rooms.json are overlaid on every response, and
 * PATCH edits that mapping (the Clean panel's "Name rooms" mode).
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; segments: Segment[]; map: string | null }>();

/** App rooms on the vacuum's floor — the candidate names for a segment. */
function roomOptions(device: Device): string[] {
  if (device.floor === null) return [];
  const rooms = registry()
    .devices.filter((d) => d.floor === device.floor && d.room && d.room !== "Whole House")
    .map((d) => d.room);
  return [...new Set(rooms)].sort((a, b) => a.localeCompare(b));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { deviceId } = await params;
  const device = getDevice(deviceId);
  if (!device) return NextResponse.json({ error: "unknown device" }, { status: 404 });
  if (device.kind !== "vacuum") {
    return NextResponse.json({ error: "not a vacuum" }, { status: 400 });
  }

  // The cache holds the raw map; names are overlaid per response so a rename
  // shows up immediately instead of after the TTL.
  const extras = { roomOptions: roomOptions(device), canRename: canProgram(auth.role) };

  const hit = cache.get(device.entityId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({
      segments: applySegmentNames(hit.segments, device.entityId),
      map: hit.map,
      ...extras,
      cached: true,
    });
  }

  try {
    const resp = await callServiceWithResponse("roborock", "get_maps", {
      entity_id: device.entityId,
    });
    const { segments, map } = parseSegments(resp, device.entityId);
    cache.set(device.entityId, { at: Date.now(), segments, map });
    return NextResponse.json({
      segments: applySegmentNames(segments, device.entityId),
      map,
      ...extras,
      cached: false,
    });
  } catch (err) {
    // No segments is a degraded-but-fine state: the panel simply offers a
    // whole-floor clean. Report why so the UI can say so honestly.
    return NextResponse.json(
      { segments: [], map: null, ...extras, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Renames are shared config, so they sit with the other programming rights.
  if (!canProgram(auth.role)) {
    return NextResponse.json({ error: "guests cannot rename rooms" }, { status: 403 });
  }

  const { deviceId } = await params;
  const device = getDevice(deviceId);
  if (!device) return NextResponse.json({ error: "unknown device" }, { status: 404 });
  if (device.kind !== "vacuum") {
    return NextResponse.json({ error: "not a vacuum" }, { status: 400 });
  }

  let body: { segment?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const segment = body.segment;
  if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0 || segment > 255) {
    return NextResponse.json({ error: "segment must be an integer map id" }, { status: 400 });
  }
  const rawName = body.name ?? null;
  if (rawName !== null && typeof rawName !== "string") {
    return NextResponse.json({ error: "name must be a string or null" }, { status: 400 });
  }
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 40) : null;

  setSegmentName(device.entityId, segment, name || null);
  audit({
    ts: new Date().toISOString(),
    user: auth.user,
    deviceId,
    entityId: device.entityId,
    command: "rename_segment",
    args: { segment, name },
    ok: true,
    durationMs: 0,
  });
  return NextResponse.json({ ok: true });
}
