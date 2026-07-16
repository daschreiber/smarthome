import { NextRequest, NextResponse } from "next/server";
import { getStates } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authorized } from "@/lib/auth";
import { saunaConfigured, saunaStatus } from "@/lib/sauna";

/**
 * Full visible-device snapshot joined with live HA state.
 * One bulk /api/states call, not N per-entity reads.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // HA bulk states and sauna status in parallel; sauna failure must not
    // break the rest of the home view.
    const [haStates, sauna] = await Promise.all([
      getStates(),
      saunaConfigured() ? saunaStatus().catch(() => null) : Promise.resolve(null),
    ]);
    const states = new Map(haStates.map((s) => [s.entity_id, s]));
    const devices = registry()
      .devices.filter((d) => d.visible)
      .map((d) => {
        if (d.kind === "sauna") {
          return {
            id: d.id,
            label: d.label,
            room: d.room,
            floor: d.floor,
            group: d.group,
            kind: d.kind,
            category: d.category,
            capabilities: d.capabilities,
            requiresConfirmation: true,
            state: sauna ? (sauna.poweredOn ? "on" : "off") : "unknown",
            available: !!sauna && sauna.connected,
            currentTemperature: sauna?.currentTemperature ?? null,
            targetTemperature: sauna?.selectedTemperature ?? null,
            hvacMode: null,
            brightnessPct: null,
            lastUpdated: null,
          };
        }
        const s = states.get(d.entityId);
        const attr = (k: string) =>
          s && typeof s.attributes[k] === "number" ? (s.attributes[k] as number) : null;
        return {
          id: d.id,
          label: d.label,
          room: d.room,
          floor: d.floor,
          group: d.group,
          kind: d.kind,
          category: d.category,
          capabilities: d.capabilities,
          requiresConfirmation: !!d.requiresConfirmation,
          state: s?.state ?? "unknown",
          available: !!s && s.state !== "unavailable" && s.state !== "unknown",
          brightnessPct:
            attr("brightness") != null ? Math.round((attr("brightness")! / 255) * 100) : null,
          currentTemperature: attr("current_temperature"),
          targetTemperature: attr("temperature"),
          hvacMode: d.kind === "climate" ? s?.state ?? null : null,
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
