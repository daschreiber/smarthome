import { NextRequest, NextResponse } from "next/server";
import { callServiceWithResponse } from "@/lib/ha";
import { getDevice } from "@/lib/registry";
import { authenticate } from "@/lib/auth";
import { parseSegments, type Segment } from "@/lib/vacuum";

/**
 * Vacuum map segments (the named rooms on the Roborock's own floor map),
 * fetched via the roborock.get_maps service so the Clean panel can offer
 * per-room cleaning. Segment ids/names live in the Roborock app's map;
 * renames there show up here after the cache expires.
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; segments: Segment[]; map: string | null }>();

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

  const hit = cache.get(device.entityId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ segments: hit.segments, map: hit.map, cached: true });
  }

  try {
    const resp = await callServiceWithResponse("roborock", "get_maps", {
      entity_id: device.entityId,
    });
    const { segments, map } = parseSegments(resp, device.entityId);
    cache.set(device.entityId, { at: Date.now(), segments, map });
    return NextResponse.json({ segments, map, cached: false });
  } catch (err) {
    // No segments is a degraded-but-fine state: the panel simply offers a
    // whole-floor clean. Report why so the UI can say so honestly.
    return NextResponse.json(
      { segments: [], map: null, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
