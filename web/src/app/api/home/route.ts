import { NextRequest, NextResponse } from "next/server";
import { getStates } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authenticate } from "@/lib/auth";
import { coolmasterEntityId } from "@/lib/coolmaster";
import { saunaConfigured, saunaScheduleStatus, saunaStatus } from "@/lib/sauna";
import { noiseConfigured, noiseStatus } from "@/lib/whitenoise";

/**
 * Full visible-device snapshot joined with live HA state.
 * One bulk /api/states call, not N per-entity reads.
 */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // HA bulk states and sauna status in parallel; sauna failure must not
    // break the rest of the home view — but the REASON travels to the card.
    let saunaNote: string | null = saunaConfigured() ? null : "not configured";
    const [haStates, sauna, saunaSchedule] = await Promise.all([
      getStates(),
      saunaConfigured()
        ? saunaStatus().catch((err: unknown) => {
            saunaNote = err instanceof Error ? err.message : String(err);
            return null;
          })
        : Promise.resolve(null),
      saunaConfigured() ? saunaScheduleStatus() : Promise.resolve({ stopAt: null }),
    ]);
    let noiseNote: string | null = null;
    const noise = noiseConfigured()
      ? await noiseStatus().catch((err: unknown) => {
          noiseNote = err instanceof Error ? err.message : String(err);
          return null;
        })
      : null;
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
            note: sauna && !sauna.connected ? "sauna is offline at KLAFS" : saunaNote,
            stopAt: sauna?.poweredOn ? saunaSchedule.stopAt : null,
          };
        }
        if (d.kind === "noise") {
          return {
            id: d.id,
            label: d.label,
            room: d.room,
            floor: d.floor,
            group: d.group,
            kind: d.kind,
            category: d.category,
            capabilities: d.capabilities,
            requiresConfirmation: false,
            // "on" means something is genuinely playing the stream.
            state: noise ? (noise.listeners > 0 ? "on" : "off") : "unknown",
            available: !!noise,
            brightnessPct: null,
            currentTemperature: null,
            targetTemperature: null,
            hvacMode: null,
            lastUpdated: null,
            note: noiseNote,
            noiseType: noise?.noiseType ?? null,
            volumePct: noise?.volume ?? null,
          };
        }
        const s = states.get(d.entityId);
        const attr = (k: string) =>
          s && typeof s.attributes[k] === "number" ? (s.attributes[k] as number) : null;
        // The Control4 zone entity never carries a real setpoint; the zone's
        // first CoolMaster unit does, once the coolmaster integration exists.
        const unit = d.coolmasterUnits?.length
          ? states.get(coolmasterEntityId(d.coolmasterUnits[0]))
          : undefined;
        const unitTarget =
          unit && typeof unit.attributes.temperature === "number"
            ? (unit.attributes.temperature as number)
            : null;
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
          targetTemperature: unitTarget ?? attr("temperature"),
          hvacMode: d.kind === "climate" ? s?.state ?? null : null,
          batteryPct: d.kind === "vacuum" ? attr("battery_level") : null,
          lastUpdated: s?.last_updated ?? null,
          note: null as string | null,
        };
      });
    // White noise is hidden from the registry (and thus the command,
    // automation, and assistant layers) until it's configured. But hiding it
    // outright reads as "the feature is missing," so the home view surfaces a
    // display-only, unavailable card that names what's absent. It becomes the
    // real card the moment WHITENOISE_BASE_URL / WHITENOISE_TOKEN are set.
    if (!noiseConfigured()) {
      devices.push({
        id: "master_bedroom__white_noise",
        label: "White noise",
        room: "Master Bedroom",
        floor: 6,
        group: "Media",
        kind: "noise",
        category: "noise_machine",
        capabilities: [],
        requiresConfirmation: false,
        state: "unknown",
        available: false,
        brightnessPct: null,
        currentTemperature: null,
        targetTemperature: null,
        hvacMode: null,
        lastUpdated: null,
        note: "not configured — set WHITENOISE_BASE_URL and WHITENOISE_TOKEN",
        noiseType: null,
        volumePct: null,
      });
    }

    // Same pattern for the Roborocks: until the Roborock integration is added
    // on the Green and the entity map re-exported, show display-only cards in
    // their rooms so the feature reads as "coming", not missing. They become
    // real vacuum devices the moment vacuum.* rows land in the entity map.
    if (!registry().devices.some((d) => d.kind === "vacuum")) {
      for (const v of [
        { id: "lounge__robot_vacuum", room: "Lounge", floor: 6 as const },
        { id: "den__robot_vacuum", room: "Den", floor: 5 as const },
      ]) {
        devices.push({
          id: v.id,
          label: "Robot vacuum",
          room: v.room,
          floor: v.floor,
          group: "Appliances",
          kind: "vacuum",
          category: "vacuum",
          capabilities: [],
          requiresConfirmation: false,
          state: "unknown",
          available: false,
          brightnessPct: null,
          currentTemperature: null,
          targetTemperature: null,
          hvacMode: null,
          batteryPct: null,
          lastUpdated: null,
          note: "not connected — add the Roborock integration in Home Assistant",
        });
      }
    }

    // The underfloor-heating valve relays are hidden as CONTROLS (plumbing,
    // per the entity map), but their state makes an honest read-only
    // indicator: which rooms have warm floors right now.
    const floorHeatingRooms = [
      ...new Set(
        registry()
          .devices.filter((d) => d.category === "floor_heating" && d.room)
          .filter((d) => states.get(d.entityId)?.state === "on")
          .map((d) => d.room),
      ),
    ];

    // The role rides along so the UI can hide programming affordances for
    // guests; enforcement lives in the API routes, never in the browser.
    return NextResponse.json({ devices, role: auth.role, floorHeatingRooms });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failure" },
      { status: 502 },
    );
  }
}
