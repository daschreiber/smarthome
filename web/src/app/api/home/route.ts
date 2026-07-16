import { NextRequest, NextResponse } from "next/server";
import { getStates } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authorized } from "@/lib/auth";

/**
 * Full visible-device snapshot joined with live HA state.
 * One bulk /api/states call, not N per-entity reads.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
    const devices = registry()
      .devices.filter((d) => d.visible)
      .map((d) => {
        const s = states.get(d.entityId);
        return {
          id: d.id,
          label: d.label,
          room: d.room,
          floor: d.floor,
          group: d.group,
          kind: d.kind,
          capabilities: d.capabilities,
          state: s?.state ?? "unknown",
          available: !!s && s.state !== "unavailable" && s.state !== "unknown",
          brightnessPct:
            s && typeof s.attributes.brightness === "number"
              ? Math.round(((s.attributes.brightness as number) / 255) * 100)
              : null,
          lastUpdated: s?.last_updated ?? null,
        };
      });
    return NextResponse.json({ devices });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failure" },
      { status: 502 },
    );
  }
}
